const http = require('http');
const { Client, GatewayIntentBits, EmbedBuilder, PermissionFlagsBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
require('dotenv').config();

// ==================== CONFIGURATION ====================
const CONFIG_FILE = './config.json';
let config = loadConfig();

// WHITELIST: Add your server IDs here (right-click server → Copy ID)
const ALLOWED_SERVERS = process.env.ALLOWED_SERVERS 
    ? process.env.ALLOWED_SERVERS.split(',') 
    : []; // Empty = allow all servers

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        }
    } catch (error) {
        console.error('Error loading config:', error.message);
    }
    
    // New structure: array of translation pairs
    return {
        translationPairs: [],
        translationServices: ['libretranslate', 'mymemory'],
        libreInstances: [
            'https://translate.argosopentech.com/translate',
            'https://libretranslate.com/translate',
            'https://translate.terraprint.co/translate'
        ]
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

// ==================== WEB SERVER ====================
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const pairCount = config.translationPairs ? config.translationPairs.length : 0;
        res.end(JSON.stringify({
            status: 'healthy',
            uptime: Math.floor(process.uptime()),
            bot: client.user ? client.user.tag : 'Connecting...',
            guilds: client.guilds ? client.guilds.cache.size : 0,
            activePairs: pairCount,
            timestamp: new Date().toISOString()
        }));
    } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        const pairCount = config.translationPairs ? config.translationPairs.length : 0;
        res.end(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Discord Translation Bot</title>
                <style>
                    * { margin: 0; padding: 0; box-sizing: border-box; }
                    body { 
                        font-family: 'Segoe UI', sans-serif;
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        color: white;
                        min-height: 100vh;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        padding: 20px;
                    }
                    .container { text-align: center; max-width: 600px; }
                    h1 { font-size: 3em; margin-bottom: 10px; }
                    .status { 
                        background: #57F287; 
                        color: #1e1e1e;
                        padding: 15px 30px; 
                        border-radius: 10px; 
                        display: inline-block; 
                        margin: 20px 0;
                        font-weight: bold;
                    }
                    .info { 
                        background: rgba(255,255,255,0.1);
                        border-radius: 10px;
                        padding: 20px;
                        margin-top: 20px;
                    }
                    .info p { margin: 8px 0; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>🌍 Translation Bot</h1>
                    <p>Advanced multi-channel translation</p>
                    <div class="status">✅ Online & Running</div>
                    <div class="info">
                        <p><strong>Bot:</strong> ${client.user ? client.user.tag : 'Connecting...'}</p>
                        <p><strong>Servers:</strong> ${client.guilds ? client.guilds.cache.size : 0}</p>
                        <p><strong>Active Pairs:</strong> ${pairCount}</p>
                        <p><strong>Uptime:</strong> ${Math.floor(process.uptime())}s</p>
                    </div>
                </div>
            </body>
            </html>
        `);
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Web server running on port ${PORT}`);
});

// ==================== DISCORD CLIENT ====================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ]
});

// ==================== TRANSLATION FUNCTIONS ====================

/**
 * Try LibreTranslate instances (faster, better quality)
 */
async function translateWithLibre(text, sourceLang, targetLang) {
    for (const instance of config.libreInstances) {
        try {
            const response = await axios.post(instance, {
                q: text,
                source: sourceLang,
                target: targetLang,
                format: 'text'
            }, {
                timeout: 8000,
                headers: { 'Content-Type': 'application/json' }
            });
            
            if (response.data.translatedText) {
                console.log(`✅ Translated with LibreTranslate: ${instance}`);
                return response.data.translatedText;
            }
        } catch (error) {
            console.log(`⚠️ LibreTranslate instance failed: ${instance}`);
            continue; // Try next instance
        }
    }
    
    throw new Error('All LibreTranslate instances failed');
}

/**
 * MyMemory fallback
 */
async function translateWithMyMemory(text, sourceLang, targetLang) {
    try {
        const response = await axios.get('https://api.mymemory.translated.net/get', {
            params: {
                q: text,
                langpair: `${sourceLang}|${targetLang}`,
                de: 'discord-translation@bot.com'
            },
            timeout: 10000
        });
        
        if (response.data.responseStatus === 200) {
            console.log(`✅ Translated with MyMemory`);
            return response.data.responseData.translatedText;
        }
        
        throw new Error('MyMemory translation failed');
    } catch (error) {
        console.error('MyMemory error:', error.message);
        throw error;
    }
}

/**
 * Language detection using character analysis
 */
function detectLanguage(text) {
    const cleanText = text.replace(/[^\p{L}\s]/gu, '');
    const totalChars = cleanText.length;
    
    if (totalChars === 0) return 'en';
    
    // Count characters by script
    const scripts = {
        hindi: (cleanText.match(/[\u0900-\u097F]/g) || []).length,
        arabic: (cleanText.match(/[\u0600-\u06FF]/g) || []).length,
        chinese: (cleanText.match(/[\u4E00-\u9FFF]/g) || []).length,
        japanese: (cleanText.match(/[\u3040-\u309F\u30A0-\u30FF]/g) || []).length,
        korean: (cleanText.match(/[\uAC00-\uD7AF]/g) || []).length,
        cyrillic: (cleanText.match(/[\u0400-\u04FF]/g) || []).length,
        latin: (cleanText.match(/[a-zA-Z]/g) || []).length
    };
    
    // Detect based on 30% threshold
    if (scripts.hindi > totalChars * 0.3) return 'hi';
    if (scripts.arabic > totalChars * 0.3) return 'ar';
    if (scripts.chinese > totalChars * 0.3) return 'zh';
    if (scripts.japanese > totalChars * 0.3) return 'ja';
    if (scripts.korean > totalChars * 0.3) return 'ko';
    if (scripts.cyrillic > totalChars * 0.3) return 'ru';
    
    return 'en'; // Default to English
}

/**
 * Main translation function with multi-service fallback
 */
async function translate(text, sourceLang, targetLang) {
    // Auto-detect if source is 'auto'
    let finalSourceLang = sourceLang;
    if (sourceLang === 'auto') {
        finalSourceLang = detectLanguage(text);
        console.log(`🔍 Auto-detected: ${finalSourceLang}`);
    }
    
    // Skip if source and target are the same
    if (finalSourceLang === targetLang) {
        console.log(`⏭️ Skipping: same language (${finalSourceLang})`);
        return null;
    }
    
    // Try LibreTranslate first (better quality)
    try {
        return await translateWithLibre(text, finalSourceLang, targetLang);
    } catch (libreError) {
        console.log('⚠️ LibreTranslate failed, trying MyMemory...');
        
        // Fallback to MyMemory
        try {
            return await translateWithMyMemory(text, finalSourceLang, targetLang);
        } catch (myMemoryError) {
            throw new Error('All translation services failed');
        }
    }
}

// ==================== HELPER FUNCTIONS ====================

/**
 * Find all translation pairs for a channel
 */
function getTranslationPairsForChannel(channelId) {
    return config.translationPairs.filter(pair => 
        pair.sourceChannel === channelId || pair.targetChannel === channelId
    );
}

/**
 * Check if translation pair already exists
 */
function pairExists(sourceId, targetId) {
    return config.translationPairs.some(pair =>
        (pair.sourceChannel === sourceId && pair.targetChannel === targetId) ||
        (pair.sourceChannel === targetId && pair.targetChannel === sourceId)
    );
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
    
    // Server whitelist check
    if (ALLOWED_SERVERS.length > 0 && !ALLOWED_SERVERS.includes(message.guild.id)) {
        console.log(`⚠️ Ignoring message from unauthorized server: ${message.guild.name}`);
        return;
    }
    
    // Ensure translationPairs exists
    if (!config.translationPairs || config.translationPairs.length === 0) return;
    
    // Find all translation pairs where this channel is the source
    const pairs = config.translationPairs.filter(p => p.sourceChannel === message.channel.id);
    
    if (pairs.length === 0) return;
    
    const textToTranslate = message.content.trim();
    if (!textToTranslate && message.attachments.size === 0) return;
    
    // Mark message as processed to prevent loops
    markAsTranslated(message.id);
    
    // Translate to all target channels
    for (const pair of pairs) {
        try {
            const targetChannel = await client.channels.fetch(pair.targetChannel).catch(() => null);
            if (!targetChannel) {
                console.error(`❌ Target channel ${pair.targetChannel} not found`);
                continue;
            }
            
            let translatedText = '';
            let detectedLang = pair.sourceLang;
            
            if (textToTranslate) {
                // Auto-detect if needed
                if (pair.sourceLang === 'auto') {
                    detectedLang = detectLanguage(textToTranslate);
                }
                
                // Skip if same language
                if (detectedLang === pair.targetLang) {
                    console.log(`⏭️ Skipping ${message.channel.name} → ${targetChannel.name}: same language`);
                    continue;
                }
                
                console.log(`🔄 Translating: ${message.channel.name} → ${targetChannel.name} (${detectedLang} → ${pair.targetLang})`);
                
                translatedText = await translate(textToTranslate, pair.sourceLang, pair.targetLang);
                
                if (!translatedText) continue; // Skip if translation returned null
            }
            
            // Create embed
            const embed = new EmbedBuilder()
                .setAuthor({
                    name: message.author.displayName || message.author.username,
                    iconURL: message.author.displayAvatarURL()
                })
                .setColor(0x5865F2)
                .setTimestamp(message.createdAt);
            
            // Footer with language info
            const langInfo = pair.sourceLang === 'auto' 
                ? `Detected ${detectedLang.toUpperCase()} → ${pair.targetLang.toUpperCase()}`
                : `${pair.sourceLang.toUpperCase()} → ${pair.targetLang.toUpperCase()}`;
            
            embed.setFooter({ text: `Translated: ${langInfo}` });
            
            if (translatedText) {
                embed.setDescription(translatedText);
            }
            
            // Handle attachments
            const attachments = Array.from(message.attachments.values());
            if (attachments.length > 0) {
                const attachmentLinks = attachments.map(att => `[${att.name}](${att.url})`).join('\n');
                embed.addFields({ name: '📎 Attachments', value: attachmentLinks });
                
                const firstImage = attachments.find(att => att.contentType?.startsWith('image/'));
                if (firstImage) embed.setImage(firstImage.url);
            }
            
            await targetChannel.send({ embeds: [embed] });
            console.log(`✅ Translated to ${targetChannel.name}`);
            
        } catch (error) {
            console.error(`❌ Translation error for pair ${pair.id}:`, error.message);
        }
    }
});

// ==================== SLASH COMMANDS ====================

const commands = [
    new SlashCommandBuilder()
        .setName('add')
        .setDescription('Add a translation pair')
        .addChannelOption(option =>
            option.setName('source')
                .setDescription('Source channel')
                .setRequired(true))
        .addChannelOption(option =>
            option.setName('target')
                .setDescription('Target channel')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('source_lang')
                .setDescription('Source language (en, hi, es, fr, de, ar, zh, ja, ko, auto)')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('target_lang')
                .setDescription('Target language (en, hi, es, fr, de, ar, zh, ja, ko)')
                .setRequired(true))
        .addBooleanOption(option =>
            option.setName('bidirectional')
                .setDescription('Enable translation in both directions?')
                .setRequired(false)),
    
    new SlashCommandBuilder()
        .setName('remove')
        .setDescription('Remove a translation pair')
        .addStringOption(option =>
            option.setName('pair_id')
                .setDescription('ID of the pair to remove (use /list to see IDs)')
                .setRequired(true)),
    
    new SlashCommandBuilder()
        .setName('list')
        .setDescription('List all active translation pairs'),
    
    new SlashCommandBuilder()
        .setName('clear')
        .setDescription('Remove all translation pairs'),
    
    new SlashCommandBuilder()
        .setName('languages')
        .setDescription('Show supported language codes'),
    
    new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Check bot status and latency')
];

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    
    const { commandName } = interaction;
    
    // Server whitelist check
    if (ALLOWED_SERVERS.length > 0 && !ALLOWED_SERVERS.includes(interaction.guild.id)) {
        return interaction.reply({
            content: '🔒 This bot is private and only works in authorized servers.',
            flags: [4096]
        });
    }
    
    // Public commands
    if (commandName === 'languages') {
        const embed = new EmbedBuilder()
            .setTitle('🌍 Supported Languages')
            .setColor(0x5865F2)
            .setDescription('**Use these codes with `/add` command:**')
            .addFields(
                { 
                    name: '🇬🇧 Common', 
                    value: '`en` English\n`hi` Hindi\n`es` Spanish\n`fr` French\n`de` German\n`ar` Arabic', 
                    inline: true 
                },
                { 
                    name: '🇨🇳 Asian', 
                    value: '`zh` Chinese\n`ja` Japanese\n`ko` Korean\n`th` Thai\n`vi` Vietnamese\n`id` Indonesian', 
                    inline: true 
                },
                { 
                    name: '🇪🇺 European', 
                    value: '`it` Italian\n`pt` Portuguese\n`ru` Russian\n`pl` Polish\n`nl` Dutch\n`tr` Turkish', 
                    inline: true 
                },
                { 
                    name: '🔍 Auto-Detection', 
                    value: '`auto` - Automatically detect source language', 
                    inline: false 
                }
            )
            .setFooter({ text: 'Example: /add source:#english target:#hindi source_lang:en target_lang:hi' });
        
        return interaction.reply({ embeds: [embed], flags: [4096] });
    }
    
    if (commandName === 'ping') {
        const latency = Date.now() - interaction.createdTimestamp;
        const apiLatency = Math.round(client.ws.ping);
        
        const embed = new EmbedBuilder()
            .setTitle('🏓 Pong!')
            .setColor(0x00FF00)
            .addFields(
                { name: 'Bot Latency', value: `${latency}ms`, inline: true },
                { name: 'API Latency', value: `${apiLatency}ms`, inline: true },
                { name: 'Active Pairs', value: `${config.translationPairs.length}`, inline: true }
            )
            .setTimestamp();
        
        return interaction.reply({ embeds: [embed], flags: [4096] });
    }
    
    // Admin-only commands
    if (!isAdmin(interaction.member)) {
        return interaction.reply({
            content: '❌ You need Administrator permissions to use this command.',
            flags: [4096]
        });
    }
    
    try {
        if (commandName === 'add') {
            // Defer reply for slow operations
            await interaction.deferReply({ flags: [4096] });
            
            const source = interaction.options.getChannel('source');
            const target = interaction.options.getChannel('target');
            const sourceLang = interaction.options.getString('source_lang').toLowerCase();
            const targetLang = interaction.options.getString('target_lang').toLowerCase();
            const bidirectional = interaction.options.getBoolean('bidirectional') ?? true;
            
            // Validate languages
            const validLangs = ['en', 'hi', 'es', 'fr', 'de', 'ar', 'zh', 'ja', 'ko', 'pt', 'ru', 'it', 'tr', 'pl', 'nl', 'th', 'vi', 'id', 'auto'];
            
            if (!validLangs.includes(sourceLang)) {
                return interaction.editReply({
                    content: `❌ Invalid source language: \`${sourceLang}\`\nUse \`/languages\` to see supported codes.`
                });
            }
            
            if (!validLangs.includes(targetLang) || targetLang === 'auto') {
                return interaction.editReply({
                    content: `❌ Invalid target language: \`${targetLang}\`\nTarget cannot be "auto".`
                });
            }
            
            // Check if pair already exists
            if (pairExists(source.id, target.id)) {
                return interaction.editReply({
                    content: `⚠️ A translation pair already exists between ${source} and ${target}.\nUse \`/remove\` to delete it first.`
                });
            }
            
            // Ensure translationPairs array exists
            if (!config.translationPairs) {
                config.translationPairs = [];
            }
            
            // Create pair ID
            const pairId = `${source.id}-${target.id}`;
            
            // Add forward translation
            config.translationPairs.push({
                id: pairId,
                sourceChannel: source.id,
                targetChannel: target.id,
                sourceLang: sourceLang,
                targetLang: targetLang,
                createdAt: new Date().toISOString()
            });
            
            // Add reverse if bidirectional
            if (bidirectional) {
                const reversePairId = `${target.id}-${source.id}`;
                config.translationPairs.push({
                    id: reversePairId,
                    sourceChannel: target.id,
                    targetChannel: source.id,
                    sourceLang: targetLang,
                    targetLang: sourceLang,
                    createdAt: new Date().toISOString()
                });
            }
            
            saveConfig();
            
            const direction = bidirectional ? '↔️' : '→';
            const sourceLangDisplay = sourceLang === 'auto' ? 'AUTO' : sourceLang.toUpperCase();
            
            await interaction.editReply({
                content: `✅ **Translation pair added!**\n${source} (${sourceLangDisplay}) ${direction} ${target} (${targetLang.toUpperCase()})\n\n*Pair ID: \`${pairId}\`*`
            });
            
        } else if (commandName === 'remove') {
            await interaction.deferReply({ flags: [4096] });
            
            const pairId = interaction.options.getString('pair_id');
            
            if (!config.translationPairs) {
                config.translationPairs = [];
            }
            
            const initialLength = config.translationPairs.length;
            config.translationPairs = config.translationPairs.filter(p => !p.id.startsWith(pairId) && !p.id.endsWith(pairId));
            
            if (config.translationPairs.length === initialLength) {
                return interaction.editReply({
                    content: `❌ Pair ID \`${pairId}\` not found.\nUse \`/list\` to see all pairs.`
                });
            }
            
            saveConfig();
            
            await interaction.editReply({
                content: `✅ Translation pair \`${pairId}\` removed!`
            });
            
        } else if (commandName === 'list') {
            await interaction.deferReply({ flags: [4096] });
            
            // Ensure translationPairs exists
            if (!config.translationPairs) {
                config.translationPairs = [];
            }
            
            if (config.translationPairs.length === 0) {
                return interaction.editReply({
                    content: '📊 No active translation pairs.\nUse `/add` to create one!'
                });
            }
            
            const embed = new EmbedBuilder()
                .setTitle('📊 Active Translation Pairs')
                .setColor(0x5865F2)
                .setDescription(`Total: **${config.translationPairs.length}** pairs`)
                .setTimestamp();
            
            // Group pairs by unique combinations
            const seen = new Set();
            
            for (const pair of config.translationPairs) {
                const key = [pair.sourceChannel, pair.targetChannel].sort().join('-');
                if (seen.has(key)) continue;
                seen.add(key);
                
                const sourceLangDisplay = pair.sourceLang === 'auto' ? 'AUTO' : pair.sourceLang.toUpperCase();
                
                // Check if bidirectional
                const reverse = config.translationPairs.find(p => 
                    p.sourceChannel === pair.targetChannel && 
                    p.targetChannel === pair.sourceChannel
                );
                
                const direction = reverse ? '↔️' : '→';
                
                embed.addFields({
                    name: `<#${pair.sourceChannel}> ${direction} <#${pair.targetChannel}>`,
                    value: `${sourceLangDisplay} ${direction} ${pair.targetLang.toUpperCase()}\n*ID: \`${pair.id}\`*`,
                    inline: false
                });
            }
            
            await interaction.editReply({ embeds: [embed] });
            
        } else if (commandName === 'clear') {
            await interaction.deferReply({ flags: [4096] });
            
            // Ensure translationPairs exists
            if (!config.translationPairs) {
                config.translationPairs = [];
            }
            
            const count = config.translationPairs.length;
            
            if (count === 0) {
                return interaction.editReply({
                    content: '📊 No translation pairs to clear.'
                });
            }
            
            config.translationPairs = [];
            saveConfig();
            
            await interaction.editReply({
                content: `✅ Cleared **${count}** translation pair(s)!`
            });
        }
        
    } catch (error) {
        console.error('Command error:', error);
        await interaction.reply({
            content: '❌ An error occurred while executing the command.',
            flags: [4096]
        }).catch(() => {});
    }
});

// ==================== BOT READY ====================

client.once('clientReady', async () => {
    console.log(`✅ Bot logged in as ${client.user.tag}`);
    console.log(`📡 Serving ${client.guilds.cache.size} server(s)`);
    
    // Show whitelist status
    if (ALLOWED_SERVERS.length > 0) {
        console.log(`🔒 Server whitelist active: ${ALLOWED_SERVERS.length} allowed server(s)`);
    } else {
        console.log(`🌐 Public mode: Bot works in all servers`);
    }
    
    // Ensure translationPairs exists
    if (!config.translationPairs) {
        config.translationPairs = [];
    }
    
    console.log(`🔄 Active translation pairs: ${config.translationPairs.length}`);
    
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    
    try {
        console.log('🔄 Registering slash commands...');
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands }
        );
        console.log('✅ Slash commands registered');
    } catch (error) {
        console.error('❌ Error registering commands:', error);
    }
    
    const pairCount = config.translationPairs ? config.translationPairs.length : 0;
    const mode = ALLOWED_SERVERS.length > 0 ? '🔒 Private' : '🌐 Public';
    client.user.setActivity(`${mode} | ${pairCount} pairs`, { type: 3 });
});

// ==================== ERROR HANDLING ====================

client.on('error', error => {
    console.error('❌ Discord client error:', error);
});

process.on('unhandledRejection', error => {
    console.error('❌ Unhandled rejection:', error);
});

// ==================== START BOT ====================

const token = process.env.DISCORD_TOKEN;

if (!token) {
    console.error('❌ DISCORD_TOKEN not set!');
    process.exit(1);
}

client.login(token).catch(error => {
    console.error('❌ Login failed:', error.message);
    process.exit(1);
});