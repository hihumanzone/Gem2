const { Client, GatewayIntentBits, AttachmentBuilder, InteractionType } = require('discord.js');
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fetch = require('node-fetch');
const pdfParse = require('pdf-parse');
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
    }
  } catch (error) {
    console.error(error);
  }
});

client.on('messageCreate', async message => {
  try {
    if ((message.mentions.has(client.user) && !message.mentions.everyone) ||
        message.content.toLowerCase().includes(client.user.displayName.toLowerCase())) {
      if (!message.author.bot) {
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

            const now = new Date();
            const utc = now.toUTCString();

            const serverName = message.guild.name;
            
            const systemInstructions = `You are an AI known as ${client.user.displayName}. You are currently engaging with users in the ${serverName} Discord server. You will receive messages in the following format: "[User's message in the ChannelName channel]:". When responding, you do not need to follow this format. Avoid using emojis in your responses. You are mainly built as a conversational AI, but you can do other things as well. Be understanding, build friendships, and play along.\n\n## User Information\nUsername: \`${userInfo.username}\`\nDisplay Name: \`${userInfo.displayName}\`\nServer Nickname: \`${userInfo.serverNickname || 'Not set'}\`\nStatus: \`${userInfo.status}\`\n\n## General Information:\nUTC Date And Time: \`${utc}\``

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

            let prompt = message.content

            message.guild.members.cache.forEach(member => {
              prompt = prompt.replace(new RegExp(`<@!?${member.id}>`, 'g'), `"@${member.displayName}"`);
            });

            message.guild.channels.cache.forEach(channel => {
              prompt = prompt.replace(new RegExp(`<#${channel.id}>`, 'g'), `"#${channel.name}"`);
            });

            const channelName = message.channel.name;
            prompt = `[${userInfo.displayName}'s Message In #${channelName} Channel]: ${prompt}`;
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
              text = text.replace(new RegExp(`@${member.displayName}`, 'g'), `<@${member.id}>`);
            });

            message.guild.channels.cache.forEach(channel => {
              text = text.replace(new RegExp(`#${channel.name}`, 'g'), `<#${channel.id}>`);
            });

            console.log(`\n${prompt}\nBot response: ${text}\n`);
            serverHistory.set(message.guildId, history);
            await saveServerHistory(message.guildId, history);

            if (text.length > 1950) {
              if (sendAsFile) {
                await sendAsTextFile(text, message);
              } else {
                await sendTextInChunks(text, message);
              }
            } else {
              await message.reply(text);
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
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }

        if (!success) {
          console.error(`After ${retryAttempts} attempts, the operation failed.`);
        }
      }
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
      // Ensure to split at a word boundary
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
client.login(token);