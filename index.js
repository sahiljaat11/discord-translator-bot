const http = require('http');
const { Client, GatewayIntentBits, EmbedBuilder, PermissionFlagsBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
require('dotenv').config();

// ==================== CONFIGURATION ====================
const CONFIG_FILE = './config.json';
let config = loadConfig();

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        }
    } catch (error) {
        console.error('Error loading config:', error.message);
    }
    
    return {
        channelMappings: {},
        libreTranslateURL: 'https://libretranslate.com/translate',
        adminRoleId: null
    };
}

function saveConfig() {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        console.log('✅ Configuration saved');
    } catch (error) {
        console.error('❌ Error saving config:', error.message);
    }
}

// ==================== WEB SERVER (RENDER REQUIREMENT) ====================
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'healthy',
            uptime: Math.floor(process.uptime()),
            bot: client.user ? client.user.tag : 'Connecting...',
            guilds: client.guilds ? client.guilds.cache.size : 0,
            timestamp: new Date().toISOString()
        }));
    } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Discord Translation Bot</title>
                <style>
                    body { 
                        font-family: Arial; 
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        color: white;
                        text-align: center;
                        padding: 50px;
                        min-height: 100vh;
                        margin: 0;
                    }
                    h1 { font-size: 3em; margin-bottom: 20px; }
                    .status { 
                        background: #57F287; 
                        color: #1e1e1e;
                        padding: 15px 30px; 
                        border-radius: 10px; 
                        display: inline-block; 
                        margin-top: 20px;
                        font-weight: bold;
                    }
                </style>
            </head>
            <body>
                <h1>🌍 Translation Bot</h1>
                <p>Real-time Discord translation service</p>
                <div class="status">✅ Online & Running</div>
                <p style="margin-top: 30px;">Bot: ${client.user ? client.user.tag : 'Connecting...'}</p>
                <p>Uptime: ${Math.floor(process.uptime())}s</p>
            </body>
            </html>
        `);
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Web server running on port ${PORT}`);
});

// ==================== DISCORD CLIENT SETUP ====================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ]
});

// ==================== TRANSLATION FUNCTIONS ====================

/**
 * Translate text using LibreTranslate
 */
async function translateWithLibre(text, sourceLang, targetLang) {
    try {
        const response = await axios.post(config.libreTranslateURL, {
            q: text,
            source: sourceLang,
            target: targetLang,
            format: 'text'
        }, {
            timeout: 10000,
            headers: { 'Content-Type': 'application/json' }
        });
        
        return response.data.translatedText;
    } catch (error) {
        console.error('LibreTranslate error:', error.message);
        throw error;
    }
}

/**
 * Main translation function with retry
 */
async function translate(text, sourceLang, targetLang, retryCount = 0) {
    try {
        return await translateWithLibre(text, sourceLang, targetLang);
    } catch (error) {
        if (retryCount < 1) {
            console.log('🔄 Retrying translation...');
            await new Promise(resolve => setTimeout(resolve, 1000));
            return translate(text, sourceLang, targetLang, retryCount + 1);
        }
        throw new Error('Translation service failed');
    }
}

// ==================== HELPER FUNCTIONS ====================

function getTranslationConfig(channelId) {
    return config.channelMappings[channelId] || null;
}

const recentTranslations = new Set();

function isRecentlyTranslated(messageId) {
    return recentTranslations.has(messageId);
}

function markAsTranslated(messageId) {
    recentTranslations.add(messageId);
    setTimeout(() => recentTranslations.delete(messageId), 30000);
}

function isAdmin(member) {
    return member.permissions.has(PermissionFlagsBits.Administrator);
}

// ==================== MESSAGE HANDLER ====================

client.on('messageCreate', async (message) => {
    // Ignore bot messages (prevent loops)
    if (message.author.bot) return;
    
    // Ignore if already processed
    if (isRecentlyTranslated(message.id)) return;
    
    // Check if channel is configured for translation
    const translationConfig = getTranslationConfig(message.channel.id);
    if (!translationConfig) return;
    
    const { targetChannel, sourceLang, targetLang } = translationConfig;
    
    // Get target channel
    const targetChannelObj = await client.channels.fetch(targetChannel).catch(() => null);
    if (!targetChannelObj) {
        console.error(`❌ Target channel ${targetChannel} not found`);
        return;
    }
    
    try {
        // Extract message content
        let textToTranslate = message.content.trim();
        
        if (!textToTranslate && message.attachments.size === 0) return;
        
        // Translate if there's text
        let translatedText = '';
        if (textToTranslate) {
            translatedText = await translate(textToTranslate, sourceLang, targetLang);
        }
        
        // Create embed for translated message
        const embed = new EmbedBuilder()
            .setAuthor({
                name: message.author.displayName || message.author.username,
                iconURL: message.author.displayAvatarURL()
            })
            .setColor(0x5865F2)
            .setTimestamp(message.createdAt)
            .setFooter({ text: `Translated from ${sourceLang.toUpperCase()} → ${targetLang.toUpperCase()}` });
        
        if (translatedText) {
            embed.setDescription(translatedText);
        }
        
        // Handle attachments
        const attachments = Array.from(message.attachments.values());
        if (attachments.length > 0) {
            const attachmentLinks = attachments.map(att => `[${att.name}](${att.url})`).join('\n');
            embed.addFields({ name: '📎 Attachments', value: attachmentLinks });
            
            // Add first image as thumbnail if exists
            const firstImage = attachments.find(att => att.contentType?.startsWith('image/'));
            if (firstImage) {
                embed.setImage(firstImage.url);
            }
        }
        
        // Send translated message
        await targetChannelObj.send({ embeds: [embed] });
        
        // Mark as translated to prevent loops
        markAsTranslated(message.id);
        
        console.log(`✅ Translated message from ${message.channel.name} to ${targetChannelObj.name}`);
        
    } catch (error) {
        console.error('❌ Translation error:', error.message);
        
        // Send error notification to source channel
        await message.reply({
            content: '⚠️ Translation failed. Please try again later.',
            ephemeral: true
        }).catch(() => {});
    }
});

// ==================== SLASH COMMANDS ====================

const commands = [
    new SlashCommandBuilder()
        .setName('setlanguage')
        .setDescription('Configure translation for a channel')
        .addChannelOption(option =>
            option.setName('source_channel')
                .setDescription('The channel to translate from')
                .setRequired(true))
        .addChannelOption(option =>
            option.setName('target_channel')
                .setDescription('The channel to send translations to')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('source_lang')
                .setDescription('Source language code (e.g., en, hi, es)')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('target_lang')
                .setDescription('Target language code (e.g., en, hi, es)')
                .setRequired(true)),
    
    new SlashCommandBuilder()
        .setName('removelanguage')
        .setDescription('Remove translation configuration from a channel')
        .addChannelOption(option =>
            option.setName('channel')
                .setDescription('The channel to remove translation from')
                .setRequired(true)),
    
    new SlashCommandBuilder()
        .setName('status')
        .setDescription('Show all active translation configurations'),
    
    new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Check bot latency and status')
];

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    
    const { commandName } = interaction;
    
    // Check admin permissions
    if (!isAdmin(interaction.member)) {
        return interaction.reply({
            content: '❌ You need Administrator permissions to use this command.',
            ephemeral: true
        });
    }
    
    try {
        if (commandName === 'setlanguage') {
            const sourceChannel = interaction.options.getChannel('source_channel');
            const targetChannel = interaction.options.getChannel('target_channel');
            const sourceLang = interaction.options.getString('source_lang').toLowerCase();
            const targetLang = interaction.options.getString('target_lang').toLowerCase();
            
            // Configure bidirectional translation
            config.channelMappings[sourceChannel.id] = {
                targetChannel: targetChannel.id,
                sourceLang: sourceLang,
                targetLang: targetLang
            };
            
            config.channelMappings[targetChannel.id] = {
                targetChannel: sourceChannel.id,
                sourceLang: targetLang,
                targetLang: sourceLang
            };
            
            saveConfig();
            
            await interaction.reply({
                content: `✅ Translation configured:\n` +
                        `${sourceChannel} (${sourceLang.toUpperCase()}) ↔️ ${targetChannel} (${targetLang.toUpperCase()})`,
                ephemeral: true
            });
            
        } else if (commandName === 'removelanguage') {
            const channel = interaction.options.getChannel('channel');
            
            if (!config.channelMappings[channel.id]) {
                return interaction.reply({
                    content: '❌ This channel has no translation configured.',
                    ephemeral: true
                });
            }
            
            const targetChannelId = config.channelMappings[channel.id].targetChannel;
            
            delete config.channelMappings[channel.id];
            delete config.channelMappings[targetChannelId];
            
            saveConfig();
            
            await interaction.reply({
                content: `✅ Translation removed from ${channel}`,
                ephemeral: true
            });
            
        } else if (commandName === 'status') {
            const mappings = Object.entries(config.channelMappings);
            
            if (mappings.length === 0) {
                return interaction.reply({
                    content: '📊 No active translations configured.',
                    ephemeral: true
                });
            }
            
            // Get unique pairs (avoid duplicates from bidirectional config)
            const processed = new Set();
            const pairs = [];
            
            for (const [channelId, cfg] of mappings) {
                const pairKey = [channelId, cfg.targetChannel].sort().join('-');
                if (!processed.has(pairKey)) {
                    processed.add(pairKey);
                    pairs.push({
                        channel1: channelId,
                        channel2: cfg.targetChannel,
                        lang1: cfg.sourceLang,
                        lang2: cfg.targetLang
                    });
                }
            }
            
            const embed = new EmbedBuilder()
                .setTitle('📊 Active Translation Configurations')
                .setColor(0x5865F2)
                .setTimestamp();
            
            for (const pair of pairs) {
                embed.addFields({
                    name: `<#${pair.channel1}> ↔️ <#${pair.channel2}>`,
                    value: `${pair.lang1.toUpperCase()} ↔️ ${pair.lang2.toUpperCase()}`
                });
            }
            
            await interaction.reply({ embeds: [embed], ephemeral: true });
            
        } else if (commandName === 'ping') {
            const latency = Date.now() - interaction.createdTimestamp;
            const apiLatency = Math.round(client.ws.ping);
            
            const embed = new EmbedBuilder()
                .setTitle('🏓 Pong!')
                .setColor(0x00FF00)
                .addFields(
                    { name: 'Bot Latency', value: `${latency}ms`, inline: true },
                    { name: 'API Latency', value: `${apiLatency}ms`, inline: true },
                    { name: 'Status', value: '✅ Online', inline: true }
                )
                .setTimestamp();
            
            await interaction.reply({ embeds: [embed], ephemeral: true });
        }
        
    } catch (error) {
        console.error('Command error:', error);
        await interaction.reply({
            content: '❌ An error occurred while executing the command.',
            ephemeral: true
        }).catch(() => {});
    }
});

// ==================== BOT READY EVENT ====================

client.once('clientReady', async () => {
    console.log(`✅ Bot logged in as ${client.user.tag}`);
    console.log(`📡 Serving ${client.guilds.cache.size} server(s)`);
    
    // Register slash commands
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    
    try {
        console.log('🔄 Registering slash commands...');
        
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands }
        );
        
        console.log('✅ Slash commands registered successfully');
    } catch (error) {
        console.error('❌ Error registering commands:', error);
    }
    
    // Set bot status
    client.user.setActivity('messages for translation', { type: 3 }); // 3 = WATCHING
});

// ==================== ERROR HANDLING ====================

client.on('error', error => {
    console.error('❌ Discord client error:', error);
});

process.on('unhandledRejection', error => {
    console.error('❌ Unhandled promise rejection:', error);
});

// ==================== START BOT ====================

const token = process.env.DISCORD_TOKEN;

if (!token) {
    console.error('❌ ERROR: DISCORD_TOKEN environment variable is not set!');
    console.error('Please add DISCORD_TOKEN in your environment variables.');
    process.exit(1);
}

client.login(token).catch(error => {
    console.error('❌ Failed to login:', error.message);
    process.exit(1);
});