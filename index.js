const { Client, GatewayIntentBits, AttachmentBuilder, InteractionType, EmbedBuilder, PermissionsBitField } = require('discord.js');
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fetch = require('node-fetch');
const pdfParse = require('pdf-parse');
const EventSource = require('eventsource');
const fs = require('fs');
const path = require('path');

const sendAsFile = false; // Set this to false if you want to send as split messages by default

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences
  ]
});
const token = process.env.DISCORD_TOKEN;
const googleAPIKey = process.env.GOOGLE_API_KEY;
const genAI = new GoogleGenerativeAI(googleAPIKey);

const serverHistory = new Map();

// Load conversation history from JSON files on startup
async function loadServerHistory() {
  const folderPath = path.join(__dirname, 'conversation_history');
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
  }

  const files = fs.readdirSync(folderPath);
  for (const file of files) {
    const filePath = path.join(folderPath, file);
    const fileContent = await fs.promises.readFile(filePath, 'utf-8');
    const serverId = path.basename(file, path.extname(file));
    const history = JSON.parse(fileContent);
    serverHistory.set(serverId, history);
  }
}

// Save conversation history to a JSON file
async function saveServerHistory(serverId, history) {
  const folderPath = path.join(__dirname, 'conversation_history');
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
  }

  const filePath = path.join(folderPath, `${serverId}.json`);
  const jsonContent = JSON.stringify(history, null, 2);
  await fs.promises.writeFile(filePath, jsonContent);
}

client.on('ready', async () => {
  console.log(`Logged in as ${client.user.tag}!`);

  // Load server history when bot starts
  await loadServerHistory();

  client.application.commands.set([
    {
      name: 'memory',
      description: 'Displays the memory of conversations in the server.'
    },
    {
      "name": "imagine",
      "description": "Generate an image based on a prompt using a selected model.",
      "options": [
        {
          "type": 3,
          "name": "prompt",
          "description": "The prompt to generate the image from.",
          "required": true
        },
        {
          "type": 3,
          "name": "aspect_ratio",
          "description": "The aspect ratio for the generated image.",
          "required": false,
          "choices": [
            { "name": "Square", "value": "Square" },
            { "name": "Landscape", "value": "Landscape" },
            { "name": "Portrait", "value": "Portrait" }
          ]
        }
      ]
    }
  ]);
});

client.on('interactionCreate', async interaction => {
  try {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;
    if (commandName === 'memory') {
      try {
        const memory = serverHistory.get(interaction.guildId);

        if (memory) {
          const memoryJson = JSON.stringify(memory, null, 2);
          if (sendAsFile) {
            const filePath = './memory.json';
            await fs.promises.writeFile(filePath, memoryJson);
            const attachment = new AttachmentBuilder(filePath);
            await interaction.reply({ content: 'Here is the memory JSON file:', files: [attachment] });
            await fs.promises.unlink(filePath);
          } else {
            await sendTextInChunks(memoryJson, interaction);
          }
        } else {
          await interaction.reply('No memory for this server.');
        }
      } catch (error) {
        console.error(error);
      }
    } else if (commandName === 'imagine') {
      const prompt = interaction.options.getString('prompt');
      const aspect_ratio = interaction.options.getString('aspect_ratio') || 'Square';
      await interaction.deferReply();
      try {
        const loadingEmbed = new EmbedBuilder()
          .setColor(0x36393F)
          .setDescription(`\`🔄\`› Generating image in ${aspect_ratio} aspect ratio...`)
          .setTimestamp();
        await interaction.editReply({ embeds: [loadingEmbed] });
        const result = await retryOperation(() => generateImg(prompt, aspect_ratio), 3);
        const imageUrl = result.images[0].url;
        const imageAttachment = new AttachmentBuilder(imageUrl, { name: 'generated-image.png' });
        const embed = new EmbedBuilder()
          .setColor(0x36393F)
          .addFields(
            { name: 'Prompt:', value: `\`\`\`${prompt.length > 950 ? prompt.substring(0, 950) + '...' : prompt}\`\`\`` },
            { name: 'Aspect Ratio:', value: `\`${aspect_ratio}\`` }
            )
          .setImage(`attachment://generated-image.png`)
          .setTimestamp();
        const imageMessage = await interaction.followUp({
          content: `<@${interaction.user.id}>`,
          embeds: [embed],
          files: [imageAttachment]
        });
        const messageLink = `https://discord.com/channels/${interaction.guildId ? interaction.guildId : '@me'}/${interaction.channelId}/${imageMessage.id}`;
        const successfulEmbed = new EmbedBuilder()
          .setColor(0x36393F)
          .setDescription(`\`✅\`› Image generation successful! ${messageLink}`)
          .setTimestamp();
        await interaction.editReply({ embeds: [successfulEmbed] });
      } catch (error) {
        console.error(error);
        const errorEmbed = new EmbedBuilder()
          .setColor(0x36393F)
          .setDescription('`❌`› Image generation failed. Please try again later.')
          .setTimestamp();
        await interaction.editReply({ embeds: [errorEmbed] });
      }
    }
  } catch (error) {
    console.error(error.message);
  }
});

client.on('messageCreate', async message => {
  if (message.author.id === client.user.id) return;
  const botPermissions = message.channel.permissionsFor(message.guild.members.me);
  if (!botPermissions || !botPermissions.has(PermissionsBitField.Flags.SendMessages)) return;
  try {
    const retryAttempts = 3;
    let retryCount = 0;
    let success = false;

    while (!success && retryCount < retryAttempts) {
      try {
        const history = serverHistory.get(message.guildId) || [];
  
        let member = await message.guild.members.fetch(message.author.id);

        const userInfo = {
          username: message.author.username,
          displayName: message.author.displayName,
          serverNickname: message.author.nickname,
          status: member.presence ? member.presence.status : 'offline'
        };

        const time = message.createdAt.toLocaleString();

        const serverName = message.guild.name;
        
        const systemInstructions = `You are a boy AI known as ${client.user.displayName}. You are currently engaging with users in the ${serverName} Discord server. You will receive all messages in the following format: "[Time: \`User display name\`'s message in the ChannelName channel].", respond to the ones that seem to be either calling you or continuing an existing conversation. You are not allowed to also jump into other conversations, so just ignore most messages by sending a '.'. When responding, you do not need to follow this format. Avoid using emojis in your responses. You can mention users by using '@display name'. You can redirect to channels by using '#channel name'. You have the ability to see images and read text-based or PDF documents. You can send an "." to end a conversation or to avoid sending a response message on discord. You are mainly built as a conversational AI, but you can do other things as well. Be understanding, human-like, build friendships, and play along.\n\n## User Information\nUsername: \`${userInfo.username}\`\nDisplay Name: \`${userInfo.displayName}\`\nServer Nickname: \`${userInfo.serverNickname || 'Not set'}\`\nStatus: \`${userInfo.status}\``;

        const model = genAI.getGenerativeModel({
          model: 'gemini-1.5-flash',
          systemInstruction: {
            role: "system",
            parts: [
              {
                text: systemInstructions
              }
            ]
          }
        });
        const chat = model.startChat({ history: history });

        let prompt = message.content;

        const escapeRegex = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        message.guild.members.cache.forEach(member => {
          const displayNameEscaped = escapeRegex(member.displayName);
          prompt = prompt.replace(new RegExp(`<@!?${member.id}>`, 'g'), `"@${displayNameEscaped}"`);
        });

        message.guild.channels.cache.forEach(channel => {
          const channelNameEscaped = escapeRegex(channel.name);
          prompt = prompt.replace(new RegExp(`<#${channel.id}>`, 'g'), `"#${channelNameEscaped}"`);
        });

        const channelName = message.channel.name;
        prompt = `[\`${time}\` :\`${userInfo.displayName}\`'s Message In #${channelName} Channel]: ${prompt}`;
        if (message.reference && message.reference.messageId) {
          const repliedMessage = await message.channel.messages.fetch(message.reference.messageId);
          const repliedUsername = repliedMessage.author.username;
          const repliedDisplayName = repliedMessage.author.displayName;
          const repliedTime = repliedMessage.createdAt.toLocaleString();
          const repliedContent = repliedMessage.content;
          prompt = prompt += `\n\n{REPLYING TO:\nUser: \`${repliedUsername}\` (Display Name: \`${repliedDisplayName}\`)\nTime: \`${repliedTime}\`\n[Message]: ${repliedContent}\n}`;
        }
        prompt = await extractText(message, prompt);
        let parts = [{ "text": prompt }];

        if (message.attachments.size > 0) {
          const attachmentParts = await Promise.all(
            message.attachments
            .filter(attachment => attachment.contentType && attachment.contentType.startsWith('image/'))
            .map(async (attachment) => {
              const response = await fetch(attachment.url);
              const buffer = await response.buffer();
              return {
                inlineData: {
                  data: buffer.toString('base64'),
                  mimeType: attachment.contentType || 'application/octet-stream'
                }
              };
            })
          );
          parts = [...parts, ...attachmentParts];
        }

        const result = await chat.sendMessage(parts);
        const response = await result.response;
        let text = response.text();

        message.guild.members.cache.forEach(member => {
          const displayNameEscaped = escapeRegex(member.displayName);
          text = text.replace(new RegExp(`@${displayNameEscaped}`, 'g'), `<@${member.id}>`);
        });

        message.guild.channels.cache.forEach(channel => {
          const channelNameEscaped = escapeRegex(channel.name);
          text = text.replace(new RegExp(`#${channelNameEscaped}`, 'g'), `<#${channel.id}>`);
        });

        serverHistory.set(message.guildId, history);
        await saveServerHistory(message.guildId, history);

        if (text.length > 1950) {
          if (sendAsFile) {
            await sendAsTextFile(text, message);
          } else {
            await sendTextInChunks(text, message);
          }
        } else if (text.trim() !== '.') {
          await message.channel.send(text);
        }
        success = true;
      } catch (retryError) {
        retryCount++;
        console.error(`Attempt ${retryCount} failed: ${retryError}`);
        if (retryError.message && retryError.message.startsWith('[GoogleGenerativeAI Error]: Candidate was blocked due to')) {
          const history = serverHistory.get(message.guildId) || [];
          if (history.length >= 2) {
            history.pop();
            history.pop();
            serverHistory.set(message.guildId, history);
          }
          success = true;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    if (!success) {
      console.error(`After ${retryAttempts} attempts, the operation failed.`);
    }
  } catch (err) {
    console.error('Failed to process message:', err);
  }
});


async function extractText(message, messageContent) {
  if (message.attachments.size > 0) {
    let attachments = Array.from(message.attachments.values());
    for (const attachment of attachments) {
      const fileType = attachment.name.split('.').pop().toLowerCase();
      const fileTypes = ['html', 'js', 'css', 'json', 'xml', 'csv', 'py', 'java', 'sql', 'log', 'md', 'txt', 'pdf'];

      if (fileTypes.includes(fileType)) {
        try {
          let fileContent = await downloadAndReadFile(attachment.url, fileType);
          messageContent += `\n\n[\`${attachment.name}\` File Content]:\n\`\`\`\n${fileContent}\n\`\`\``;
        } catch (error) {
          console.error(`Error reading file ${attachment.name}: ${error.message}`);
        }
      }
    }
  }
  return messageContent;
}

async function downloadAndReadFile(url, fileType) {
  let response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download ${response.statusText}`);

  switch (fileType) {
    case 'pdf':
      let buffer = await response.buffer();
      return (await pdfParse(buffer)).text;
    default:
      return await response.text();
  }
}

async function sendAsTextFile(text, message) {
  try {
    const filename = `response-${Date.now()}.txt`;
    await fs.promises.writeFile(filename, text);
    const botMessage = await message.reply({ content: `Here is the response:`, files: [filename] });
    await fs.promises.unlink(filename);
  } catch (error) {
    console.error('Error sending text file:', error);
    await sendTextInChunks(text, message);
  }
}

async function sendTextInChunks(text, message) {
  const maxLength = 1950;
  let offset = 0;
  let partCount = 0;

  while (offset < text.length) {
    let end = offset + maxLength;
    if (end > text.length) {
      end = text.length;
    } else {
      while (end > offset && !/\s/.test(text[end])) {
        end--;
      }
    }

    const part = text.slice(offset, end).trim();
    offset = end;

    if (partCount === 0) {
      await message.reply(part);
    } else {
      await message.channel.send(part);
    }

    partCount++;
  }
}

function generateSessionHash() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = '';
  for (let i = 0; i < 5; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function generateRandomDigits() {
  return Math.floor(Math.random() * (999999999 - 100000000 + 1) + 100000000);
}

function generateImg(prompt, aspect_ratio) {
  let width, height;
  if (aspect_ratio == 'Square') {
    width = 1024;
    height = 1024;
  } else if (aspect_ratio == 'Landscape') {
    width = 1280;
    height = 768;
  } else if (aspect_ratio == 'Portrait') {
    width = 768;
    height = 1280;
  }
  return new Promise(async (resolve, reject) => {
    try {
      const randomDigits = generateRandomDigits();
      const sessionHash = generateSessionHash();

      // First request to join the queue
      await fetch("https://ehristoforu-dalle-3-xl-lora-v2.hf.space/queue/join?", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          data: [prompt, '', false, randomDigits, width, height, 6, true],
          event_data: null,
          fn_index: 3,
          trigger_id: 6,
          session_hash: sessionHash
        }),
      });

      // Replace this part to use EventSource for listening to the event stream
      const es = new EventSource(`https://ehristoforu-dalle-3-xl-lora-v2.hf.space/queue/data?session_hash=${sessionHash}`);

      es.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.msg === 'process_completed') {
          es.close();
          const outputUrl = data?.output?.data?.[0]?.[0]?.image?.url;
          if (!outputUrl) {
            reject(new Error("Output URL does not exist, path might be invalid."));
            console.log(data);
          } else {
            resolve({ images: [{ url: outputUrl }]});
          }
        }
      };

      es.onerror = (error) => {
        es.close();
        reject(error);
      };
    } catch (error) {
      reject(error);
    }
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function retryOperation(fn, maxRetries, delayMs = 1000) {
  let error;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      console.log(`Attempt ${attempt} failed: ${err.message}`);
      error = err;
      if (attempt < maxRetries) {
        console.log(`Waiting ${delayMs}ms before next attempt...`);
        await delay(delayMs);
      } else {
        console.log(`All ${maxRetries} attempts failed.`);
      }
    }
  }

  throw new Error(`Operation failed after ${maxRetries} attempts: ${error.message}`);
}

client.login(token);
