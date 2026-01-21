const http = require('http');
const { Client, GatewayIntentBits, EmbedBuilder, PermissionFlagsBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
require('dotenv').config();

// ==================== CONFIG ====================
const CONFIG_FILE = './config.json';

let config = {
    channelLanguages: {},
    translationService: 'auto'
};

if (fs.existsSync(CONFIG_FILE)) {
    try {
        const old = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        if (old.channelLanguages) {
            config = old;
        }
    } catch {}
}

function saveConfig() {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// ==================== WEB SERVER (OPTIONAL) ====================
const PORT = process.env.PORT || 3000;
http.createServer((_, res) => {
    res.writeHead(200);
    res.end('Discord Translation Bot is running');
}).listen(PORT);

// ==================== DISCORD CLIENT ====================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// ==================== TRANSLATION PROVIDERS ====================

// 1️⃣ LibreTranslate (better quality)
async function translateLibre(text, from, to) {
    const res = await axios.post(
        'https://libretranslate.de/translate',
        { q: text, source: from, target: to, format: 'text' },
        { timeout: 10000 }
    );
    return res.data.translatedText;
}

// 2️⃣ MyMemory fallback
async function translateMyMemory(text, from, to) {
    const res = await axios.get('https://api.mymemory.translated.net/get', {
        params: { q: text, langpair: `${from}|${to}` },
        timeout: 10000
    });
    return res.data.responseData.translatedText;
}

// Unified translator
async function translate(text, from, to) {
    try {
        return await translateLibre(text, from, to);
    } catch {
        return await translateMyMemory(text, from, to);
    }
}

// ==================== HELPERS ====================

function isAdmin(member) {
    return member.permissions.has(PermissionFlagsBits.Administrator);
}

const recent = new Set();
function mark(id) {
    recent.add(id);
    setTimeout(() => recent.delete(id), 30000);
}

// ==================== AUTO CHANNEL TRANSLATION ====================

client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    if (recent.has(msg.id)) return;

    const fromLang = config.channelLanguages[msg.channel.id];
    if (!fromLang) return;

    for (const [channelId, toLang] of Object.entries(config.channelLanguages)) {
        if (channelId === msg.channel.id) continue;
        if (fromLang === toLang) continue;

        try {
            const translated = await translate(msg.content, fromLang, toLang);
            const ch = await client.channels.fetch(channelId);
            await ch.send({
                embeds: [
                    new EmbedBuilder()
                        .setAuthor({ name: msg.author.username, iconURL: msg.author.displayAvatarURL() })
                        .setDescription(translated)
                        .setFooter({ text: `${fromLang.toUpperCase()} → ${toLang.toUpperCase()}` })
                        .setTimestamp()
                ]
            });
        } catch {}
    }

    mark(msg.id);
});

// ==================== SLASH COMMANDS ====================

const commands = [
    new SlashCommandBuilder()
        .setName('setlang')
        .setDescription('Assign a language to a channel')
        .addChannelOption(o => o.setName('channel').setRequired(true))
        .addStringOption(o => o.setName('language').setRequired(true)),

    new SlashCommandBuilder()
        .setName('removelang')
        .setDescription('Remove channel from translation')
        .addChannelOption(o => o.setName('channel').setRequired(true)),

    new SlashCommandBuilder()
        .setName('listlangs')
        .setDescription('List language mappings'),

    new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Bot latency')
];

client.on('interactionCreate', async (i) => {
    if (!i.isChatInputCommand()) return;
    if (!isAdmin(i.member)) return i.reply({ content: 'Admin only', ephemeral: true });

    if (i.commandName === 'setlang') {
        config.channelLanguages[i.options.getChannel('channel').id] =
            i.options.getString('language').toLowerCase();
        saveConfig();
        return i.reply({ content: '✅ Language set', ephemeral: true });
    }

    if (i.commandName === 'removelang') {
        delete config.channelLanguages[i.options.getChannel('channel').id];
        saveConfig();
        return i.reply({ content: '🗑️ Removed', ephemeral: true });
    }

    if (i.commandName === 'listlangs') {
        const list = Object.entries(config.channelLanguages)
            .map(([id, l]) => `<#${id}> → ${l}`)
            .join('\n') || 'None';
        return i.reply({ content: list, ephemeral: true });
    }

    if (i.commandName === 'ping') {
        return i.reply({ content: `🏓 ${client.ws.ping}ms`, ephemeral: true });
    }
});

// ==================== READY ====================

client.once('clientReady', async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
});

// ==================== START ====================

client.login(process.env.DISCORD_TOKEN);
