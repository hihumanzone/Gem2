# Discord Conversational AI Bot

This is a Discord bot designed to utilize Google's Generative AI (Gemini 1.5-Flash model) to engage with users in conversation, remember previous interactions, and process visual and textual data from attachments. The bot can also display conversation history and respond to user mentions.

## Features

- **Conversational AI:** Engages with users in a conversational manner.
- **Memory:** Remembers past conversations and interactions within each server.
- **Attachment Processing:** Understand certain types of image and text file attachments.
- **Error Handling & Retry Logic:** Retries failed requests to the Google Generative AI service.

## Setup

### Prerequisites

1. **Node.js:** Ensure you have Node.js installed. You can download it [here](https://nodejs.org/).
2. **Discord Bot Token:** You need a bot token from the Discord Developer Portal. You can create a bot [here](https://discord.com/developers/applications).
3. **Google AI API Key:** You need an API key from Google Cloud's Generative AI service. Find more information [here](https://aistudio.google.com/app/apikey).

### Installation

1. **Clone the repository:**

    ```sh
    git clone https://github.com/your-username/discord-conversational-ai-bot.git
    cd discord-conversational-ai-bot
    ```

2. **Install dependencies:**

    ```sh
    npm install @google/generative-ai fs discord.js dotenv node-fetch@2.6.7 pdf-parse path
    ```

3. **Configure environment variables:**

    Create a `.env` file in the root directory and add your Discord bot token and Google API key:

    ```sh
    DISCORD_TOKEN=your_discord_token
    GOOGLE_API_KEY=your_google_api_key
    ```

### Running the Bot

```sh
node index.js
```

## Usage

### Commands

- **/memory:** Displays the memory of conversations in the server.

## Error Handling

The bot includes retry logic to handle temporary failures when interacting with Google's Generative AI service. The bot retries up to 3 times before giving up on a request.

## Contributing

Feel free to open issues or submit pull requests with improvements!

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

## Acknowledgements

- [Discord.js](https://discord.js.org/) for the Discord API
- [Google Generative AI](https://aistudio.google.com/app/) for the AI service

--- 

For any questions or issues, please open an issue on the repository or contact the maintainer.
