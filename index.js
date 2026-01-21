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
        translationService: 'mymemory',
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
                <p>Real-time Discord translation with auto-detection</p>
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
 * Translate text using MyMemory (Free, no API key required)
 */
async function translateWithMyMemory(text, sourceLang, targetLang) {
    try {
        const response = await axios.get('https://api.mymemory.translated.net/get', {
            params: {
                q: text,
                langpair: `${sourceLang}|${targetLang}`,
                de: 'discord-bot@translation.com' // Email for better quota
            },
            timeout: 10000,
            headers: {
                'User-Agent': 'Discord Translation Bot'
            }
        });
        
        if (response.data.responseStatus !== 200) {
            throw new Error(`MyMemory error: ${response.data.responseDetails || 'Unknown error'}`);
        }
        
        return response.data.responseData.translatedText;
        
    } catch (error) {
        console.error('MyMemory translation error:', error.response?.data || error.message);
        throw error;
    }
}

/**
 * Detect language using heuristics (character script analysis)
 */
function detectLanguageHeuristic(text) {
    // Remove emojis and special characters
    const cleanText = text.replace(/[^\p{L}\s]/gu, '');
    
    // Count characters by script
    const hindiChars = (cleanText.match(/[\u0900-\u097F]/g) || []).length;
    const arabicChars = (cleanText.match(/[\u0600-\u06FF]/g) || []).length;
    const chineseChars = (cleanText.match(/[\u4E00-\u9FFF]/g) || []).length;
    const japaneseChars = (cleanText.match(/[\u3040-\u309F\u30A0-\u30FF]/g) || []).length;
    const koreanChars = (cleanText.match(/[\uAC00-\uD7AF]/g) || []).length;
    const cyrillicChars = (cleanText.match(/[\u0400-\u04FF]/g) || []).length;
    const latinChars = (cleanText.match(/[a-zA-Z]/g) || []).length;
    
    const totalChars = cleanText.length;
    
    if (totalChars === 0) return 'en'; // Default if no valid characters
    
    // Determine language based on character distribution (30% threshold)
    if (hindiChars > totalChars * 0.3) return 'hi';
    if (arabicChars > totalChars * 0.3) return 'ar';
    if (chineseChars > totalChars * 0.3) return 'zh';
    if (japaneseChars > totalChars * 0.3) return 'ja';
    if (koreanChars > totalChars * 0.3) return 'ko';
    if (cyrillicChars > totalChars * 0.3) return 'ru';
    
    // Default to English for Latin script or mixed content
    return 'en';
}

/**
 * Detect language of text
 */
async function detectLanguage(text) {
    try {
        console.log(`🔍 Detecting language for: "${text.substring(0, 50)}..."`);
        const detected = detectLanguageHeuristic(text);
        console.log(`✅ Detected language: ${detected}`);
        return detected;
    } catch (error) {
        console.error('Language detection error:', error.message);
        return 'en'; // Default to English on error
    }
}

/**
 * Main translation function with retry logic
 */
async function translate(text, sourceLang, targetLang, retryCount = 0) {
    try {
        return await translateWithMyMemory(text, sourceLang, targetLang);
    } catch (error) {
        if (retryCount < 1) {
            console.log('🔄 Retrying translation...');
            await new Promise(resolve => setTimeout(resolve, 2000));
            return translate(text, sourceLang, targetLang, retryCount + 1);
        }
        throw new Error('Translation service failed after retry: ' + error.message);
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
    if (message.author.bot) return;
    if (isRecentlyTranslated(message.id)) return;
    
    const translationConfig = getTranslationConfig(message.channel.id);
    if (!translationConfig) return;
    
    const { targetChannel, sourceLang, targetLang } = translationConfig;
    const targetChannelObj = await client.channels.fetch(targetChannel).catch(() => null);
    
    if (!targetChannelObj) {
        console.error(`❌ Target channel ${targetChannel} not found`);
        return;
    }
    
    try {
        let textToTranslate = message.content.trim();
        if (!textToTranslate && message.attachments.size === 0) return;
        
        let translatedText = '';
        if (textToTranslate) {
            // Auto-detect source language if set to "auto"
            let detectedLang = sourceLang;
            if (sourceLang === 'auto') {
                detectedLang = await detectLanguage(textToTranslate);
                console.log(`🔍 Auto-detected language: ${detectedLang}`);
            }
            
            // Skip translation if detected language matches target
            if (detectedLang === targetLang) {
                console.log(`⏭️ Skipping: message already in target language (${targetLang})`);
                return;
            }
            
            console.log(`🔄 Translating: "${textToTranslate}" (${detectedLang} → ${targetLang})`);
            translatedText = await translate(textToTranslate, detectedLang, targetLang);
            console.log(`✅ Translation result: "${translatedText}"`);
        }
        
        const embed = new EmbedBuilder()
            .setAuthor({
                name: message.author.displayName || message.author.username,
                iconURL: message.author.displayAvatarURL()
            })
            .setColor(0x5865F2)
            .setTimestamp(message.createdAt);
        
        // Show detected language in footer if auto-detect was used
        if (sourceLang === 'auto') {
            const detectedLang = await detectLanguage(textToTranslate);
            embed.setFooter({ text: `Detected ${detectedLang.toUpperCase()} → Translated to ${targetLang.toUpperCase()}` });
        } else {
            embed.setFooter({ text: `Translated from ${sourceLang.toUpperCase()} → ${targetLang.toUpperCase()}` });
        }
        
        if (translatedText) {
            embed.setDescription(translatedText);
        }
        
        const attachments = Array.from(message.attachments.values());
        if (attachments.length > 0) {
            const attachmentLinks = attachments.map(att => `[${att.name}](${att.url})`).join('\n');
            embed.addFields({ name: '📎 Attachments', value: attachmentLinks });
            
            const firstImage = attachments.find(att => att.contentType?.startsWith('image/'));
            if (firstImage) {
                embed.setImage(firstImage.url);
            }
        }
        
        await targetChannelObj.send({ embeds: [embed] });
        markAsTranslated(message.id);
        
        console.log(`✅ Message translated from ${message.channel.name} to ${targetChannelObj.name}`);
        
    } catch (error) {
        console.error('❌ Translation error:', error.message);
        await message.reply({
            content: '⚠️ Translation failed. Please try again later.',
            flags: [4096]
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
                .setDescription('Source language (en, hi, es, fr, de, ar, zh, ja, ko) or "auto"')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('target_lang')
                .setDescription('Target language (en, hi, es, fr, de, ar, zh, ja, ko)')
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
        .setDescription('Check bot latency and status'),
    
    new SlashCommandBuilder()
        .setName('languages')
        .setDescription('Show list of supported language codes')
];

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    
    const { commandName } = interaction;
    
    if (commandName === 'languages') {
        const embed = new EmbedBuilder()
            .setTitle('🌍 Supported Language Codes')
            .setColor(0x5865F2)
            .setDescription('Use these codes with `/setlanguage` command:')
            .addFields(
                { name: 'Common Languages', value: '`en` English\n`hi` Hindi\n`es` Spanish\n`fr` French\n`de` German\n`ar` Arabic', inline: true },
                { name: 'Asian Languages', value: '`zh` Chinese\n`ja` Japanese\n`ko` Korean\n`th` Thai\n`vi` Vietnamese\n`id` Indonesian', inline: true },
                { name: 'European Languages', value: '`it` Italian\n`pt` Portuguese\n`ru` Russian\n`pl` Polish\n`nl` Dutch\n`tr` Turkish', inline: true },
                { name: 'Auto-Detection', value: '`auto` - Automatically detect source language', inline: false }
            )
            .setFooter({ text: 'Example: /setlanguage source_lang:auto target_lang:en' });
        
        return interaction.reply({ embeds: [embed], flags: [4096] });
    }
    
    if (!isAdmin(interaction.member)) {
        return interaction.reply({
            content: '❌ You need Administrator permissions to use this command.',
            flags: [4096]
        });
    }
    
    try {
        if (commandName === 'setlanguage') {
            const sourceChannel = interaction.options.getChannel('source_channel');
            const targetChannel = interaction.options.getChannel('target_channel');
            let sourceLang = interaction.options.getString('source_lang').toLowerCase();
            const targetLang = interaction.options.getString('target_lang').toLowerCase();
            
            // Validate languages
            const validLangs = ['en', 'hi', 'es', 'fr', 'de', 'ar', 'zh', 'ja', 'ko', 'pt', 'ru', 'it', 'tr', 'pl', 'nl', 'auto'];
            
            if (!validLangs.includes(sourceLang)) {
                return interaction.reply({
                    content: `❌ Invalid source language: ${sourceLang}\nSupported: ${validLangs.join(', ')}\nUse \`/languages\` to see all options.`,
                    flags: [4096]
                });
            }
            
            if (!validLangs.includes(targetLang) || targetLang === 'auto') {
                return interaction.reply({
                    content: `❌ Invalid target language: ${targetLang}\nTarget cannot be "auto". Use a specific language code.`,
                    flags: [4096]
                });
            }
            
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
            
            const langDisplay = sourceLang === 'auto' ? 'AUTO-DETECT' : sourceLang.toUpperCase();
            
            await interaction.reply({
                content: `✅ Translation configured:\n${sourceChannel} (${langDisplay}) ↔️ ${targetChannel} (${targetLang.toUpperCase()})`,
                flags: [4096]
            });
            
        } else if (commandName === 'removelanguage') {
            const channel = interaction.options.getChannel('channel');
            
            if (!config.channelMappings[channel.id]) {
                return interaction.reply({
                    content: '❌ This channel has no translation configured.',
                    flags: [4096]
                });
            }
            
            const targetChannelId = config.channelMappings[channel.id].targetChannel;
            delete config.channelMappings[channel.id];
            delete config.channelMappings[targetChannelId];
            
            saveConfig();
            
            await interaction.reply({
                content: `✅ Translation removed from ${channel}`,
                flags: [4096]
            });
            
        } else if (commandName === 'status') {
            const mappings = Object.entries(config.channelMappings);
            
            if (mappings.length === 0) {
                return interaction.reply({
                    content: '📊 No active translations configured.',
                    flags: [4096]
                });
            }
            
            const processed = new Set();
            const pairs = [];
            
            for (const [channelId, cfg] of mappings) {
                const pairKey = [channelId, cfg.targetChannel].sort().join('-');
                if (!processed.has(pairKey)) {
                    processed.add(pairKey);
                    pairs.push({
                        channel1: channelId,
                        channel2: cfg.targetChannel,
                        lang1: cfg.sourceLang === 'auto' ? 'AUTO' : cfg.sourceLang,
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
            
            await interaction.reply({ embeds: [embed], flags: [4096] });
            
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
            
            await interaction.reply({ embeds: [embed], flags: [4096] });
        }
        
    } catch (error) {
        console.error('Command error:', error);
        await interaction.reply({
            content: '❌ An error occurred while executing the command.',
            flags: [4096]
        }).catch(() => {});
    }
});

// ==================== BOT READY EVENT ====================

client.once('clientReady', async () => {
    console.log(`✅ Bot logged in as ${client.user.tag}`);
    console.log(`📡 Serving ${client.guilds.cache.size} server(s)`);
    
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
    
    client.user.setActivity('🌍 Auto-translating messages', { type: 3 });
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