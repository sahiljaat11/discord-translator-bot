const http = require('http');
const { Client, GatewayIntentBits, EmbedBuilder, PermissionFlagsBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const axios = require('axios');
require('dotenv').config();

// ==================== CONFIGURATION ====================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const ALLOWED_SERVERS = process.env.ALLOWED_SERVERS?.split(',') || [];
const TRANSLATION_COOLDOWN = 2000; // 2 seconds per user/channel
const CACHE_TTL = 120000; // 2 minutes

// PHASE 3: Reaction translation settings
const REACTION_COOLDOWN = 30000; // 30 seconds per user per message per language
const MAX_REACTIONS_PER_MINUTE = 5; // Max 5 translations per user per minute per channel

// Guild-specific storage for better performance
const guildConfigs = new Map(); // Map<guildId, {pairs: [], lastSync: timestamp}>

// PHASE 3: Reaction-enabled channels Map<guildId, Map<channelId, {cooldownEnabled}>>
const reactionChannels = new Map();

// Translation cache: Map<cacheKey, {result, timestamp}>
const translationCache = new Map();

// Rate limiting: Map<userId-channelId, timestamp>
const rateLimits = new Map();

// PHASE 3: Granular reaction rate limiting Map<userId-guildId-channelId, {count, resetTime}>
const reactionLimits = new Map();

// PHASE 3: Track translated messages Map<messageId-langCode, timestamp>
const messageTranslations = new Map();

// Recent translations to prevent loops
const recentTranslations = new Set();

// PHASE 3: Flag emoji to language code mapping
const FLAG_TO_LANG = {
    '🇬🇧': 'en', '🇺🇸': 'en', // English
    '🇪🇸': 'es', '🇲🇽': 'es', // Spanish
    '🇫🇷': 'fr', // French
    '🇩🇪': 'de', // German
    '🇮🇹': 'it', // Italian
    '🇵🇹': 'pt', '🇧🇷': 'pt', // Portuguese
    '🇷🇺': 'ru', // Russian
    '🇯🇵': 'ja', // Japanese
    '🇨🇳': 'zh', // Chinese
    '🇰🇷': 'ko', // Korean
    '🇮🇳': 'hi', // Hindi
    '🇸🇦': 'ar', // Arabic
    '🇳🇱': 'nl', // Dutch
    '🇵🇱': 'pl', // Polish
    '🇹🇷': 'tr', // Turkish
    '🇸🇪': 'sv', // Swedish
    '🇩🇰': 'da', // Danish
    '🇫🇮': 'fi', // Finnish
    '🇳🇴': 'no', // Norwegian
    '🇨🇿': 'cs', // Czech
    '🇧🇬': 'bg', // Bulgarian
    '🇷🇴': 'ro', // Romanian
    '🇬🇷': 'el', // Greek
    '🇭🇺': 'hu', // Hungarian
    '🇸🇰': 'sk', // Slovak
    '🇸🇮': 'sl', // Slovenian
    '🇪🇪': 'et', // Estonian
    '🇱🇻': 'lv', // Latvian
    '🇱🇹': 'lt', // Lithuanian
    '🇮🇩': 'id', // Indonesian
    '🇺🇦': 'uk', // Ukrainian
    '🇹🇭': 'th', // Thai
    '🇻🇳': 'vi', // Vietnamese
};

// ==================== SUPABASE FUNCTIONS ====================

async function loadGuildConfig(guildId) {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        console.log(`⚠️ Guild ${guildId}: No Supabase - using memory only`);
        return [];
    }
    
    try {
        const response = await axios.get(
            `${SUPABASE_URL}/rest/v1/translation_pairs?guildId=eq.${guildId}&select=*`,
            {
                headers: {
                    'apikey': SUPABASE_KEY,
                    'Authorization': `Bearer ${SUPABASE_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 5000
            }
        );
        
        console.log(`📂 Loaded ${response.data?.length || 0} pairs for guild ${guildId}`);
        return response.data || [];
    } catch (error) {
        console.error(`❌ Load error for guild ${guildId}:`, error.message);
        return [];
    }
}

async function loadReactionChannels(guildId) {
    if (!SUPABASE_URL || !SUPABASE_KEY) return [];
    
    try {
        const response = await axios.get(
            `${SUPABASE_URL}/rest/v1/reaction_channels?guildId=eq.${guildId}&select=*`,
            {
                headers: {
                    'apikey': SUPABASE_KEY,
                    'Authorization': `Bearer ${SUPABASE_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 5000
            }
        );
        
        console.log(`📂 Loaded ${response.data?.length || 0} reaction channels for guild ${guildId}`);
        return response.data || [];
    } catch (error) {
        console.error(`❌ Load reaction channels error:`, error.message);
        return [];
    }
}

async function upsertPairs(guildId, pairs) {
    if (!SUPABASE_URL || !SUPABASE_KEY || !pairs.length) return;
    
    try {
        await axios.post(
            `${SUPABASE_URL}/rest/v1/translation_pairs`,
            pairs,
            {
                headers: {
                    'apikey': SUPABASE_KEY,
                    'Authorization': `Bearer ${SUPABASE_KEY}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'resolution=merge-duplicates'
                },
                timeout: 5000
            }
        );
        
        console.log(`✅ Upserted ${pairs.length} pairs for guild ${guildId}`);
    } catch (error) {
        console.error(`❌ Upsert error:`, error.response?.data || error.message);
    }
}

async function upsertReactionChannel(guildId, channelId) {
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    
    try {
        await axios.post(
            `${SUPABASE_URL}/rest/v1/reaction_channels`,
            [{
                id: `${guildId}-${channelId}`,
                guildId,
                channelId,
                createdAt: new Date().toISOString()
            }],
            {
                headers: {
                    'apikey': SUPABASE_KEY,
                    'Authorization': `Bearer ${SUPABASE_KEY}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'resolution=merge-duplicates'
                },
                timeout: 5000
            }
        );
        
        console.log(`✅ Enabled reaction translation for channel ${channelId}`);
    } catch (error) {
        console.error(`❌ Upsert reaction channel error:`, error.message);
    }
}

async function deleteReactionChannel(guildId, channelId) {
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    
    try {
        await axios.delete(
            `${SUPABASE_URL}/rest/v1/reaction_channels?id=eq.${guildId}-${channelId}`,
            {
                headers: {
                    'apikey': SUPABASE_KEY,
                    'Authorization': `Bearer ${SUPABASE_KEY}`
                },
                timeout: 5000
            }
        );
        console.log(`✅ Disabled reaction translation for channel ${channelId}`);
    } catch (error) {
        console.error(`❌ Delete reaction channel error:`, error.message);
    }
}

async function deletePairs(guildId, pairIds) {
    if (!SUPABASE_URL || !SUPABASE_KEY || !pairIds.length) return;
    
    try {
        for (const id of pairIds) {
            await axios.delete(
                `${SUPABASE_URL}/rest/v1/translation_pairs?id=eq.${id}`,
                {
                    headers: {
                        'apikey': SUPABASE_KEY,
                        'Authorization': `Bearer ${SUPABASE_KEY}`
                    },
                    timeout: 5000
                }
            );
        }
        console.log(`✅ Deleted ${pairIds.length} pairs from guild ${guildId}`);
    } catch (error) {
        console.error(`❌ Delete error:`, error.message);
    }
}

// ==================== WEB SERVER ====================
const PORT = process.env.PORT;

if (PORT) {
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(`Bot Online | ${guildConfigs.size} servers`);
    });
    server.listen(PORT, '0.0.0.0', () => console.log(`🌐 Server on port ${PORT}`));
}

// ==================== DISCORD CLIENT ====================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions, // PHASE 3: For reaction handling
    ]
});

// ==================== TRANSLATION SERVICES ====================

const SERVICE_CAPABILITIES = {
    deepl: ['en', 'de', 'es', 'fr', 'it', 'nl', 'pl', 'pt', 'ru', 'ja', 'zh', 'ko', 'tr', 'sv', 'da', 'fi', 'no', 'cs', 'bg', 'ro', 'el', 'hu', 'sk', 'sl', 'et', 'lv', 'lt', 'id', 'uk'],
    mymemory: ['*'] // Supports all
};

async function translateWithDeepL(text, sourceLang, targetLang) {
    const apiKey = process.env.DEEPL_API_KEY;
    if (!apiKey) throw new Error('DeepL not configured');
    
    const langMap = { en: 'EN', de: 'DE', es: 'ES', fr: 'FR', it: 'IT', nl: 'NL', pl: 'PL', pt: 'PT-PT', ru: 'RU', ja: 'JA', zh: 'ZH', ko: 'KO', tr: 'TR', sv: 'SV', da: 'DA', fi: 'FI', no: 'NB', cs: 'CS', bg: 'BG', ro: 'RO', el: 'EL', hu: 'HU', sk: 'SK', sl: 'SL', et: 'ET', lv: 'LV', lt: 'LT', id: 'ID', uk: 'UK' };
    
    if (!langMap[targetLang]) throw new Error(`Unsupported: ${targetLang}`);
    
    const params = {
        text: [text],
        target_lang: langMap[targetLang]
    };
    
    // Only add source_lang if NOT auto
    if (sourceLang !== 'auto' && langMap[sourceLang]) {
        params.source_lang = langMap[sourceLang];
    }
    
    const response = await axios.post('https://api-free.deepl.com/v2/translate', params, {
        headers: { 'Authorization': `DeepL-Auth-Key ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 10000
    });
    
    return response.data?.translations?.[0]?.text;
}

async function translateWithMyMemory(text, sourceLang, targetLang) {
    const response = await axios.get('https://api.mymemory.translated.net/get', {
        params: { q: text, langpair: `${sourceLang}|${targetLang}` },
        timeout: 10000
    });
    
    if (response.data?.responseStatus !== 200) throw new Error('MyMemory failed');
    return response.data.responseData.translatedText;
}

function detectLanguage(text) {
    const cleanText = text.replace(/[^\p{L}\s]/gu, '');
    const total = cleanText.length;
    if (total === 0) return 'en';
    
    const scripts = {
        hi: (cleanText.match(/[\u0900-\u097F]/g) || []).length,
        ar: (cleanText.match(/[\u0600-\u06FF]/g) || []).length,
        zh: (cleanText.match(/[\u4E00-\u9FFF]/g) || []).length,
        ja: (cleanText.match(/[\u3040-\u309F\u30A0-\u30FF]/g) || []).length,
        ko: (cleanText.match(/[\uAC00-\uD7AF]/g) || []).length,
        ru: (cleanText.match(/[\u0400-\u04FF]/g) || []).length
    };
    
    for (const [lang, count] of Object.entries(scripts)) {
        if (count > total * 0.3) return lang;
    }
    
    return 'en';
}

async function translate(text, sourceLang, targetLang) {
    // Check cache
    const cacheKey = `${text}-${sourceLang}-${targetLang}`;
    const cached = translationCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        console.log(`💾 Cache hit`);
        return cached.result;
    }
    
    // Skip manual detection for 'auto' - let translation service handle it
    let finalSource = sourceLang;
    
    // Only use manual detection as fallback for MyMemory (which needs a source lang)
    if (sourceLang === 'auto') {
        finalSource = 'auto';
    }
    
    // Choose service
    const useDeepL = SERVICE_CAPABILITIES.deepl.includes(targetLang);
    
    let result;
    try {
        if (useDeepL && process.env.DEEPL_API_KEY) {
            result = await translateWithDeepL(text, finalSource, targetLang);
            console.log(`✅ DeepL (${finalSource}→${targetLang})`);
        } else {
            // MyMemory needs explicit source language
            const myMemorySource = finalSource === 'auto' ? detectLanguage(text) : finalSource;
            
            // Skip if detected same as target
            if (myMemorySource === targetLang) {
                console.log(`⏭️ Same language detected (${myMemorySource})`);
                return null;
            }
            
            result = await translateWithMyMemory(text, myMemorySource, targetLang);
            console.log(`✅ MyMemory (${myMemorySource}→${targetLang})`);
        }
    } catch (error) {
        // Fallback to MyMemory if DeepL fails
        if (useDeepL) {
            const myMemorySource = finalSource === 'auto' ? detectLanguage(text) : finalSource;
            
            if (myMemorySource === targetLang) {
                console.log(`⏭️ Same language (${myMemorySource})`);
                return null;
            }
            
            result = await translateWithMyMemory(text, myMemorySource, targetLang);
            console.log(`✅ MyMemory fallback`);
        } else {
            throw error;
        }
    }
    
    // Cache result
    translationCache.set(cacheKey, { result, timestamp: Date.now() });
    
    // Clean old cache entries every 100 translations
    if (translationCache.size > 100) {
        const now = Date.now();
        for (const [key, value] of translationCache.entries()) {
            if (now - value.timestamp > CACHE_TTL) translationCache.delete(key);
        }
    }
    
    return result;
}

// ==================== HELPER FUNCTIONS ====================

function getGuildPairs(guildId) {
    return guildConfigs.get(guildId)?.pairs || [];
}

function isAdmin(member) {
    return member.permissions.has(PermissionFlagsBits.Administrator);
}

function isRateLimited(userId, channelId) {
    const key = `${userId}-${channelId}`;
    const lastTime = rateLimits.get(key);
    const now = Date.now();
    
    if (lastTime && now - lastTime < TRANSLATION_COOLDOWN) {
        return true;
    }
    
    rateLimits.set(key, now);
    
    // Clean old entries
    if (rateLimits.size > 500) {
        for (const [k, time] of rateLimits.entries()) {
            if (now - time > TRANSLATION_COOLDOWN * 2) rateLimits.delete(k);
        }
    }
    
    return false;
}

// PHASE 3: Granular reaction rate limiting - per user per channel
function isReactionRateLimited(userId, guildId, channelId, cooldownEnabled) {
    // If cooldown is disabled for this channel, no rate limiting
    if (!cooldownEnabled) return false;
    
    const key = `${userId}-${guildId}-${channelId}`;
    const now = Date.now();
    const userLimit = reactionLimits.get(key);
    
    if (!userLimit || now > userLimit.resetTime) {
        // Reset or initialize
        reactionLimits.set(key, { count: 1, resetTime: now + REACTION_COOLDOWN });
        return false;
    }
    
    if (userLimit.count >= MAX_REACTIONS_PER_MINUTE) {
        return true;
    }
    
    userLimit.count++;
    return false;
}

function markTranslated(messageId) {
    recentTranslations.add(messageId);
    setTimeout(() => recentTranslations.delete(messageId), 30000);
}

// PHASE 3: Track message-language pairs to prevent duplicate translations
function hasBeenTranslated(messageId, targetLang) {
    const key = `${messageId}-${targetLang}`;
    const timestamp = messageTranslations.get(key);
    
    if (!timestamp) return false;
    
    // Check if translation is recent (within last 5 minutes)
    if (Date.now() - timestamp > 300000) {
        messageTranslations.delete(key);
        return false;
    }
    
    return true;
}

function markMessageTranslated(messageId, targetLang) {
    const key = `${messageId}-${targetLang}`;
    messageTranslations.set(key, Date.now());
    
    // Clean up old entries after 10 minutes
    setTimeout(() => messageTranslations.delete(key), 600000);
}

// ==================== MESSAGE HANDLER ====================

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (recentTranslations.has(message.id)) return;
    if (!message.guild) return;
    
    // Whitelist check
    if (ALLOWED_SERVERS.length > 0 && !ALLOWED_SERVERS.includes(message.guild.id)) return;
    
    // Rate limit
    if (isRateLimited(message.author.id, message.channel.id)) {
        console.log(`⏱️ Rate limited: ${message.author.tag}`);
        return;
    }
    
    const pairs = getGuildPairs(message.guild.id).filter(p => p.sourceChannel === message.channel.id);
    if (pairs.length === 0) return;
    
    const text = message.content.trim();
    if (!text && message.attachments.size === 0) return;
    
    markTranslated(message.id);
    
    for (const pair of pairs) {
        try {
            const targetChannel = await client.channels.fetch(pair.targetChannel).catch(() => null);
            if (!targetChannel) continue;
            
            let translated = '';
            if (text) {
                translated = await translate(text, pair.sourceLang, pair.targetLang);
                if (!translated) continue;
            }
            
            const embed = new EmbedBuilder()
                .setAuthor({ name: message.author.displayName, iconURL: message.author.displayAvatarURL() })
                .setColor(0x5865F2)
                .setTimestamp(message.createdAt)
                .setFooter({ text: `${pair.sourceLang.toUpperCase()}→${pair.targetLang.toUpperCase()} | Bot` });
            
            if (translated) embed.setDescription(translated);
            
            const attachments = Array.from(message.attachments.values());
            if (attachments.length > 0) {
                embed.addFields({ name: '📎 Files', value: attachments.map(a => `[${a.name}](${a.url})`).join('\n') });
                const img = attachments.find(a => a.contentType?.startsWith('image/'));
                if (img) embed.setImage(img.url);
            }
            
            const sent = await targetChannel.send({ embeds: [embed] });
            markTranslated(sent.id);
            
        } catch (error) {
            console.error(`❌ Translation failed:`, error.message);
        }
    }
});

// Handle message edits
client.on('messageUpdate', async (oldMsg, newMsg) => {
    if (newMsg.author?.bot) return;
    if (!newMsg.guild || !newMsg.content) return;
    
    // Treat as new message for simplicity
    client.emit('messageCreate', newMsg);
});

// ==================== PHASE 3: REACTION HANDLER ====================

client.on('messageReactionAdd', async (reaction, user) => {
    // Ignore bot reactions
    if (user.bot) return;
    
    // Fetch partial reactions
    if (reaction.partial) {
        try {
            await reaction.fetch();
        } catch (error) {
            console.error('Error fetching reaction:', error);
            return;
        }
    }
    
    const message = reaction.message;
    if (!message.guild) return;
    
    // Check if reaction translation is enabled for this channel
    const guildReactionChannels = reactionChannels.get(message.guild.id);
    if (!guildReactionChannels || !guildReactionChannels.has(message.channel.id)) {
        return;
    }
    
    // Get channel config to check cooldown setting
    const channelConfig = guildReactionChannels.get(message.channel.id);
    const cooldownEnabled = channelConfig?.cooldownEnabled ?? true;
    
    // Get language from flag emoji
    const emoji = reaction.emoji.name;
    const targetLang = FLAG_TO_LANG[emoji];
    
    if (!targetLang) return; // Not a supported flag
    
    // Rate limit check (per user per channel)
    if (isReactionRateLimited(user.id, message.guild.id, message.channel.id, cooldownEnabled)) {
        console.log(`⏱️ Reaction rate limited: ${user.tag} in channel ${message.channel.id}`);
        // Optionally notify user via DM or ephemeral message
        return;
    }
    
    // Check if this message-language pair has already been translated
    if (hasBeenTranslated(message.id, targetLang)) {
        console.log(`⏭️ Already translated to ${targetLang}`);
        return;
    }
    
    const text = message.content?.trim();
    if (!text) return; // No text to translate
    
    try {
        // Translate with auto-detection
        const translated = await translate(text, 'auto', targetLang);
        
        if (!translated) {
            console.log(`⏭️ No translation needed for ${targetLang}`);
            return;
        }
        
        // Create embed for translation
        const embed = new EmbedBuilder()
            .setAuthor({ 
                name: `${message.author.displayName}'s message`, 
                iconURL: message.author.displayAvatarURL() 
            })
            .setDescription(translated)
            .setColor(0x57F287)
            .setFooter({ text: `AUTO → ${targetLang.toUpperCase()} | Requested by ${user.tag}` })
            .setTimestamp();
        
        // Reply to the original message
        await message.reply({ embeds: [embed] });
        
        // Mark as translated
        markMessageTranslated(message.id, targetLang);
        
        console.log(`✅ Reaction translation: ${targetLang} by ${user.tag} in ${message.guild.name}/#${message.channel.name}`);
        
    } catch (error) {
        console.error(`❌ Reaction translation failed:`, error.message);
    }
});

// ==================== SLASH COMMANDS ====================

const commands = [
    new SlashCommandBuilder()
        .setName('add')
        .setDescription('Add translation pair')
        .addChannelOption(o => o.setName('source').setDescription('Source channel').setRequired(true))
        .addChannelOption(o => o.setName('target').setDescription('Target channel').setRequired(true))
        .addStringOption(o => o.setName('source_lang').setDescription('Source language (en, hi, es, etc) or auto').setRequired(true))
        .addStringOption(o => o.setName('target_lang').setDescription('Target language (en, hi, es, etc)').setRequired(true))
        .addBooleanOption(o => o.setName('bidirectional').setDescription('Enable both directions?')),
    
    new SlashCommandBuilder().setName('list').setDescription('List translation pairs'),
    new SlashCommandBuilder().setName('remove').setDescription('Remove pair').addStringOption(o => o.setName('pair_id').setDescription('Pair ID from /list').setRequired(true)),
    new SlashCommandBuilder().setName('clear').setDescription('Clear all pairs'),
    new SlashCommandBuilder().setName('languages').setDescription('Supported languages'),
    new SlashCommandBuilder().setName('ping').setDescription('Bot status'),
    
    // PHASE 3: New reaction commands
    new SlashCommandBuilder()
        .setName('reaction-enable')
        .setDescription('Enable reaction-based translation in this channel')
        .addBooleanOption(o => o.setName('cooldown').setDescription('Enable rate limiting? (default: true)')),
    
    new SlashCommandBuilder()
        .setName('reaction-enable-all')
        .setDescription('Enable reaction translation in ALL channels of this server')
        .addBooleanOption(o => o.setName('cooldown').setDescription('Enable rate limiting? (default: true)')),
    
    new SlashCommandBuilder()
        .setName('reaction-disable')
        .setDescription('Disable reaction-based translation in this channel'),
    
    new SlashCommandBuilder()
        .setName('reaction-disable-all')
        .setDescription('Disable reaction translation in ALL channels of this server'),
    
    new SlashCommandBuilder()
        .setName('reaction-list')
        .setDescription('List channels with reaction translation enabled'),
];

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    
    const cmd = interaction.commandName;
    const guildId = interaction.guild.id;
    
    // Whitelist
    if (ALLOWED_SERVERS.length > 0 && !ALLOWED_SERVERS.includes(guildId)) {
        return interaction.reply({ content: '🔒 Private bot', flags: [4096] });
    }
    
    if (cmd === 'languages') {
        const embed = new EmbedBuilder()
            .setTitle('🌍 Supported Languages')
            .setColor(0x5865F2)
            .addFields(
                { name: '🥇 DeepL (Best)', value: '`en` `de` `es` `fr` `it` `nl` `pl` `pt` `ru` `ja` `zh` `ko` `tr` `sv` `da` `fi` `no` `cs` `bg` `ro` `el` `hu` `sk` `sl` `et` `lv` `lt` `id` `uk`' },
                { name: '🥈 MyMemory (All Others)', value: '`hi` `ar` `th` `vi` `bn` `ta` `te` `ur` and 100+ more' },
                { name: '🔍 Auto', value: '`auto` - Detects source language automatically' },
                { name: '🎌 Reaction Flags', value: Object.entries(FLAG_TO_LANG).slice(0, 15).map(([flag, code]) => `${flag} = ${code}`).join(' • ') + '\n*and more...*' }
            );
        return interaction.reply({ embeds: [embed], flags: [4096] });
    }
    
    if (cmd === 'ping') {
        const pairs = getGuildPairs(guildId).length;
        const reactionChannelCount = reactionChannels.get(guildId)?.size || 0;
        return interaction.reply({ content: `🏓 Pong! | ${pairs} pairs | ${reactionChannelCount} reaction channels | ${translationCache.size} cached`, flags: [4096] });
    }
    
    // PHASE 3: Reaction commands (admin only)
    if (cmd === 'reaction-enable' || cmd === 'reaction-disable' || cmd === 'reaction-list' || 
        cmd === 'reaction-enable-all' || cmd === 'reaction-disable-all') {
        if (!isAdmin(interaction.member)) {
            return interaction.reply({ content: '❌ Admin only', flags: [4096] });
        }
    }
    
    if (cmd === 'reaction-enable') {
        const channelId = interaction.channel.id;
        const cooldownEnabled = interaction.options.getBoolean('cooldown') ?? true;
        
        if (!reactionChannels.has(guildId)) {
            reactionChannels.set(guildId, new Map());
        }
        
        const guildReactionChannels = reactionChannels.get(guildId);
        
        if (guildReactionChannels.has(channelId)) {
            return interaction.reply({ content: '⚠️ Reaction translation already enabled in this channel', flags: [4096] });
        }
        
        guildReactionChannels.set(channelId, { cooldownEnabled });
        await upsertReactionChannel(guildId, channelId, cooldownEnabled);
        
        const cooldownMsg = cooldownEnabled 
            ? `\n⏱️ **Cooldown:** ${MAX_REACTIONS_PER_MINUTE} translations per minute per user` 
            : '\n🚀 **Cooldown:** Disabled (unlimited translations)';
        
        return interaction.reply({ 
            content: `✅ Reaction translation enabled in <#${channelId}>!\n\n📌 Users can now react with flag emojis (🇬🇧🇪🇸🇫🇷🇩🇪🇮🇹 etc.) to translate messages.${cooldownMsg}\n⚠️ **Note:** Translations will be visible to everyone in the channel.`, 
            flags: [4096] 
        });
    }
    
    if (cmd === 'reaction-enable-all') {
        const cooldownEnabled = interaction.options.getBoolean('cooldown') ?? true;
        
        if (!reactionChannels.has(guildId)) {
            reactionChannels.set(guildId, new Map());
        }
        
        const guildReactionChannels = reactionChannels.get(guildId);
        const guild = interaction.guild;
        
        // Get all text channels
        const textChannels = guild.channels.cache.filter(ch => ch.isTextBased() && !ch.isThread());
        
        let enabledCount = 0;
        for (const [channelId, channel] of textChannels) {
            if (!guildReactionChannels.has(channelId)) {
                guildReactionChannels.set(channelId, { cooldownEnabled });
                await upsertReactionChannel(guildId, channelId, cooldownEnabled);
                enabledCount++;
            }
        }
        
        const cooldownMsg = cooldownEnabled 
            ? `\n⏱️ **Cooldown:** ${MAX_REACTIONS_PER_MINUTE} translations per minute per user per channel` 
            : '\n🚀 **Cooldown:** Disabled (unlimited translations)';
        
        return interaction.reply({ 
            content: `✅ Reaction translation enabled in **${enabledCount}** channels!${cooldownMsg}\n\n📌 Users can now react with flag emojis to translate messages across the entire server.`, 
            flags: [4096] 
        });
    }
    
    if (cmd === 'reaction-disable') {
        const channelId = interaction.channel.id;
        const guildReactionChannels = reactionChannels.get(guildId);
        
        if (!guildReactionChannels || !guildReactionChannels.has(channelId)) {
            return interaction.reply({ content: '⚠️ Reaction translation not enabled in this channel', flags: [4096] });
        }
        
        guildReactionChannels.delete(channelId);
        await deleteReactionChannel(guildId, channelId);
        
        return interaction.reply({ 
            content: `✅ Reaction translation disabled in <#${channelId}>`, 
            flags: [4096] 
        });
    }
    
    if (cmd === 'reaction-disable-all') {
        const guildReactionChannels = reactionChannels.get(guildId);
        
        if (!guildReactionChannels || guildReactionChannels.size === 0) {
            return interaction.reply({ content: '⚠️ No channels with reaction translation enabled', flags: [4096] });
        }
        
        const count = guildReactionChannels.size;
        
        // Delete all reaction channels for this guild
        for (const channelId of guildReactionChannels.keys()) {
            await deleteReactionChannel(guildId, channelId);
        }
        
        guildReactionChannels.clear();
        
        return interaction.reply({ 
            content: `✅ Reaction translation disabled in **${count}** channel(s)`, 
            flags: [4096] 
        });
    }
    
    if (cmd === 'reaction-list') {
        const guildReactionChannels = reactionChannels.get(guildId);
        
        if (!guildReactionChannels || guildReactionChannels.size === 0) {
            return interaction.reply({ content: '📊 No channels with reaction translation enabled', flags: [4096] });
        }
        
        const embed = new EmbedBuilder()
            .setTitle('📊 Reaction Translation Channels')
            .setColor(0x5865F2)
            .setDescription(`**${guildReactionChannels.size}** channel(s) with reaction translation enabled\n\nUsers can react with flag emojis to translate messages.`);
        
        let channelList = '';
        for (const [channelId, config] of guildReactionChannels) {
            const cooldownStatus = config.cooldownEnabled ? '⏱️ Cooldown ON' : '🚀 No Cooldown';
            channelList += `• <#${channelId}> - ${cooldownStatus}\n`;
        }
        
        embed.addFields({ name: 'Enabled Channels', value: channelList || 'None' });
        
        return interaction.reply({ embeds: [embed], flags: [4096] });
    }
    
    if (!isAdmin(interaction.member)) {
        return interaction.reply({ content: '❌ Admin only', flags: [4096] });
    }
    
    try {
        if (cmd === 'add') {
            const source = interaction.options.getChannel('source');
            const target = interaction.options.getChannel('target');
            const sourceLang = interaction.options.getString('source_lang').toLowerCase();
            const targetLang = interaction.options.getString('target_lang').toLowerCase();
            const bidirectional = interaction.options.getBoolean('bidirectional') ?? false;
            
            // Validation
            if (source.id === target.id) {
                return interaction.reply({ content: '❌ Source and target cannot be the same channel', flags: [4096] });
            }
            
            if (sourceLang === targetLang && sourceLang !== 'auto') {
                return interaction.reply({ content: '❌ Source and target languages cannot be the same', flags: [4096] });
            }
            
            if (targetLang === 'auto') {
                return interaction.reply({ content: '❌ Target cannot be "auto"', flags: [4096] });
            }
            
            if (!guildConfigs.has(guildId)) {
                guildConfigs.set(guildId, { pairs: [], lastSync: Date.now() });
            }
            
            const config = guildConfigs.get(guildId);
            
            // Generate unique IDs for each direction
            const forwardId = `${Date.now()}_${source.id}_${target.id}`;
            const reverseId = `${Date.now() + 1}_${target.id}_${source.id}`;
            
            // Check if forward pair already exists
            const forwardExists = config.pairs.some(p => 
                p.sourceChannel === source.id && 
                p.targetChannel === target.id
            );
            
            if (forwardExists) {
                return interaction.reply({ content: '⚠️ This exact pair already exists', flags: [4096] });
            }
            
            // Create forward pair
            const newPairs = [{
                id: forwardId,
                guildId,
                sourceChannel: source.id,
                targetChannel: target.id,
                sourceLang,
                targetLang,
                createdAt: new Date().toISOString()
            }];
            
            // Add reverse pair if bidirectional
            if (bidirectional) {
                const reverseExists = config.pairs.some(p => 
                    p.sourceChannel === target.id && 
                    p.targetChannel === source.id
                );
                
                if (!reverseExists) {
                    newPairs.push({
                        id: reverseId,
                        guildId,
                        sourceChannel: target.id,
                        targetChannel: source.id,
                        sourceLang: targetLang,
                        targetLang: sourceLang,
                        createdAt: new Date().toISOString()
                    });
                }
            }
            
            config.pairs.push(...newPairs);
            await upsertPairs(guildId, newPairs);
            
            if (bidirectional && newPairs.length === 2) {
                return interaction.reply({ 
                    content: `✅ Created 2 pairs:\n1️⃣ ${source} (${sourceLang.toUpperCase()}) → ${target} (${targetLang.toUpperCase()})\n2️⃣ ${target} (${targetLang.toUpperCase()}) → ${source} (${sourceLang.toUpperCase()})`, 
                    flags: [4096] 
                });
            } else {
                return interaction.reply({ 
                    content: `✅ ${source} (${sourceLang.toUpperCase()}) → ${target} (${targetLang.toUpperCase()})`, 
                    flags: [4096] 
                });
            }
            
        } else if (cmd === 'list') {
            const pairs = getGuildPairs(guildId);
            if (pairs.length === 0) {
                return interaction.reply({ content: '📊 No pairs in this server', flags: [4096] });
            }
            
            const embed = new EmbedBuilder()
                .setTitle('📊 Translation Pairs')
                .setColor(0x5865F2)
                .setDescription(`**${pairs.length}** pair(s) configured\n*Use \`/remove pair_id:<id>\` to remove*`);
            
            // Show each pair individually with its unique ID
            pairs.forEach((pair, index) => {
                const sourceChannel = `<#${pair.sourceChannel}>`;
                const targetChannel = `<#${pair.targetChannel}>`;
                const arrow = '→';
                
                embed.addFields({
                    name: `${index + 1}. ${sourceChannel} ${arrow} ${targetChannel}`,
                    value: `**Languages:** ${pair.sourceLang.toUpperCase()} → ${pair.targetLang.toUpperCase()}\n**ID:** \`${pair.id}\``,
                    inline: false
                });
            });
            
            return interaction.reply({ embeds: [embed], flags: [4096] });
            
        } else if (cmd === 'remove') {
            const pairIdInput = interaction.options.getString('pair_id');
            const config = guildConfigs.get(guildId);
            
            if (!config || config.pairs.length === 0) {
                return interaction.reply({ content: '❌ No pairs configured in this server', flags: [4096] });
            }
            
            // Find exact match for the pair ID
            const pairIndex = config.pairs.findIndex(p => p.id === pairIdInput);
            
            if (pairIndex === -1) {
                return interaction.reply({ 
                    content: `❌ Pair ID \`${pairIdInput}\` not found. Use \`/list\` to see all pairs.`, 
                    flags: [4096] 
                });
            }
            
            const removedPair = config.pairs[pairIndex];
            config.pairs.splice(pairIndex, 1);
            
            await deletePairs(guildId, [removedPair.id]);
            
            return interaction.reply({ 
                content: `✅ Removed: <#${removedPair.sourceChannel}> → <#${removedPair.targetChannel}> (${removedPair.sourceLang.toUpperCase()} → ${removedPair.targetLang.toUpperCase()})`, 
                flags: [4096] 
            });
            
        } else if (cmd === 'clear') {
            const config = guildConfigs.get(guildId);
            if (!config || config.pairs.length === 0) {
                return interaction.reply({ content: '📊 No pairs to clear', flags: [4096] });
            }
            
            const count = config.pairs.length;
            const ids = config.pairs.map(p => p.id);
            config.pairs = [];
            deletePairs(guildId, ids);
            
            return interaction.reply({ content: `✅ Cleared ${count} pair(s)`, flags: [4096] });
        }
        
    } catch (error) {
        console.error('Command error:', error);
        return interaction.reply({ content: '❌ Error occurred', flags: [4096] }).catch(() => {});
    }
});

// ==================== BOT READY ====================

client.once('clientReady', async () => {
    console.log(`✅ ${client.user.tag} online`);
    console.log(`📡 ${client.guilds.cache.size} server(s)`);
    
    // Load configs for all guilds
    for (const guild of client.guilds.cache.values()) {
        const pairs = await loadGuildConfig(guild.id);
        guildConfigs.set(guild.id, { pairs, lastSync: Date.now() });
        
        // PHASE 3: Load reaction channels as Map with config
        const reactionChannelData = await loadReactionChannels(guild.id);
        const channelMap = new Map();
        for (const rc of reactionChannelData) {
            channelMap.set(rc.channelId, { 
                cooldownEnabled: rc.cooldownEnabled ?? true 
            });
        }
        reactionChannels.set(guild.id, channelMap);
    }
    
    // Register commands
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        // Clear old commands first
        await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
        console.log('🔄 Cleared old commands');
        
        // Register new commands
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('✅ Commands registered (including reaction commands)');
        console.log(`📋 Total commands: ${commands.length}`);
    } catch (error) {
        console.error('❌ Command registration failed:', error);
    }
    
    const totalPairs = Array.from(guildConfigs.values()).reduce((sum, cfg) => sum + cfg.pairs.length, 0);
    client.user.setActivity(`${totalPairs} pairs | ${guildConfigs.size} servers`, { type: 3 });
});

// Load config when joining new guild
client.on('guildCreate', async (guild) => {
    const pairs = await loadGuildConfig(guild.id);
    guildConfigs.set(guild.id, { pairs, lastSync: Date.now() });
    
    // PHASE 3: Load reaction channels as Map with config
    const reactionChannelData = await loadReactionChannels(guild.id);
    const channelMap = new Map();
    for (const rc of reactionChannelData) {
        channelMap.set(rc.channelId, { 
            cooldownEnabled: rc.cooldownEnabled ?? true 
        });
    }
    reactionChannels.set(guild.id, channelMap);
});

// ==================== ERROR HANDLING ====================

client.on('error', error => console.error('Discord error:', error));
process.on('unhandledRejection', error => console.error('Unhandled rejection:', error));

// ==================== START ====================

const token = process.env.DISCORD_TOKEN;
if (!token) {
    console.error('❌ DISCORD_TOKEN not set');
    process.exit(1);
}

client.login(token);