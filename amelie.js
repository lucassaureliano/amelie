/**
 * Amélie - Assistente Virtual de IA para WhatsApp
 * 
 * Uma assistente virtual multimídia focada em acessibilidade, desenvolvida por Belle Utsch.
 * Integra-se ao WhatsApp e processa texto, áudio, imagem e vídeo para fornecer respostas acessíveis.
 * 
 * @author Belle Utsch
 * @version 1.0.0
 * @license MIT
 */

const qrcode                  = require('qrcode-terminal');
const { Client, LocalAuth }   = require('whatsapp-web.js');
const { GoogleGenerativeAI }  = require("@google/generative-ai");
const { GoogleAIFileManager } = require("@google/generative-ai/server");
const dotenv                  = require('dotenv');
const winston                 = require('winston');
const colors                  = require('colors/safe');
const Datastore               = require('nedb');
const crypto                  = require('crypto');
const fs                      = require('fs');
const path                    = require('path');
const { videoQueue, problemVideosQueue, getErrorMessageForUser, notificacoes } = require('./videoQueue');
const HeartbeatSystem = require('./heartbeat');


dotenv.config();

// Configuração de variáveis de ambiente
const API_KEY                 = process.env.API_KEY;
const MAX_HISTORY             = parseInt(process.env.MAX_HISTORY || '50');
let BOT_NAME                  = process.env.BOT_NAME || 'Amélie';

let lastProcessedAudio        = null;
let reconnectCount            = 0;
const MAX_RECONNECT_ATTEMPTS  = 5;

let debug_level               = 'info'

// Sistema de Circuit Breaker para proteger contra falhas na API
const circuitBreaker = {
    failures: 0,
    lastFailure: 0,
    state: 'CLOSED', // CLOSED, OPEN, HALF_OPEN
    threshold: 5, // Número de falhas para abrir o circuito
    resetTimeout: 60000, // 1 minuto para resetar
    
    recordSuccess() {
        this.failures = 0;
        this.state = 'CLOSED';
    },
    
    recordFailure() {
        this.failures++;
        this.lastFailure = Date.now();
        
        if (this.failures >= this.threshold) {
            this.state = 'OPEN';
            logger.warn(`⚠️ Circuit breaker aberto após ${this.failures} falhas!`);
        }
    },
    
    canExecute() {
        if (this.state === 'CLOSED') return true;
        
        if (this.state === 'OPEN') {
            if (Date.now() - this.lastFailure > this.resetTimeout) {
                this.state = 'HALF_OPEN';
                logger.info(`Circuit breaker passando para estado HALF_OPEN`);
                return true;
            }
            return false;
        }
        
        return true; // HALF_OPEN - permite uma tentativa
    }
};

/**
 * Configuração de formato personalizado para o logger
 */
const myFormat = winston.format.printf(({ timestamp, level, message, ...rest }) => {
    const extraData = Object.keys(rest).length ? JSON.stringify(rest, null, 2) : '';
    
    // Usar expressões regulares para colorir apenas partes específicas
    let coloredMessage = message;
    
    // Colorir apenas "Mensagem de [nome]" em verde
    coloredMessage = coloredMessage.replace(
        /(Mensagem de [^:]+):/g, 
        match => colors.green(match)
    );
    
    // Colorir apenas "Resposta:" em azul
    coloredMessage = coloredMessage.replace(
        /\b(Resposta):/g, 
        match => colors.blue(match)
    );
    
    return `${timestamp} [${colors.yellow(level)}]: ${coloredMessage} ${extraData}`;
});

/**
 * Configuração do logger com saída para console e arquivo
 */
const logger = winston.createLogger({
    level: debug_level,
    format: winston.format.combine(
        winston.format.timestamp(),
        myFormat
    ),
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.timestamp(
                    {
                        format: 'DD/MM/YYYY HH:mm:ss'
                    }
                ),
                myFormat
            )
        }),
        new winston.transports.File({ 
            filename: 'bot.log',
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.uncolorize(), // Remove cores para o arquivo de log
                winston.format.printf(({ timestamp, level, message, ...rest }) => {
                    const extraData = Object.keys(rest).length ? JSON.stringify(rest, null, 2) : '';
                    return `${timestamp} [${level}]: ${message} ${extraData}`;
                })
            )
        })
    ]
});

// Configuração dos bancos de dados NeDB
const promptsDb  = new Datastore({ filename: './db/prompts.db' , autoload: true });
const configDb   = new Datastore({ filename: './db/config.db'  , autoload: true });
const groupsDb   = new Datastore({ filename: './db/groups.db'  , autoload: true });
const usersDb    = new Datastore({ filename: './db/users.db'   , autoload: true });

// Inicialização do GoogleGenerativeAI
const genAI = new GoogleGenerativeAI(API_KEY);

// Cache para armazenar instâncias do modelo
const modelCache = new Map();

/**
 * Verifica se o cliente do WhatsApp está conectado e pronto
 * @returns {boolean} Verdadeiro se o cliente estiver pronto
 */
function isClientReady() {
    return client && client.info && client.info.wid && 
           client.info.connected === true && 
           client.pupPage && client.pupBrowser;
}

/**
 * Gera uma chave única baseada nas configurações do modelo
 * @param {Object} config - Configurações do modelo
 * @returns {string} Chave única para cache
 */
function getModelCacheKey(config) {
    const {
        model = "gemini-2.0-flash",
        temperature = 0.9,
        topK = 1,
        topP = 0.95,
        maxOutputTokens = 1024,
        systemInstruction = `Seu nome é ${BOT_NAME}. Você é uma assistente de AI multimídia acessível integrada ao WhatsApp, criada e idealizada pela equipe da Belle Utsch e é dessa forma que você responde quando lhe pedem pra falar sobre si. 
        
        Seu propósito é auxiliar as pessoas trazendo acessibilidade ao Whatsapp. Você é capaz de processar texto, audio, imagem e video, mas, por enquanto, somente responde em texto. 

        Sua transcrição de audios, quando ativada, é verbatim. Transcreva o que foi dito, palavra a palavra.

        Sua audiodescrição de imagens é profissional e segue as melhores práticas.
        
        Seus comandos podem ser encontrados digitando !ajuda. 
        
        Se alguém perguntar, aqui está sua lista de comandos: 
        /cego - Aplica configurações para usuários com deficiência visual; 
        /audio - Liga/desliga a transcrição de áudio; 
        /video - Liga/desliga a interpretação de vídeo; 
        /imagem - Liga/desliga a audiodescrição de imagem; 
        /reset - Limpa o histórico de conversa, restaura todas as configurações originais e desativa o modo cego; 
        /prompt set <nome> <texto> - Define uma nova personalidade; 
        /prompt get <nome> - Mostra uma personalidade existente; 
        /prompt list - Lista todas as personalidades; 
        /prompt use <nome> - Usa uma personalidade específica; 
        /prompt clear - Remove a personalidade ativa; 
        /config set <param> <valor> - Define um parâmetro de configuração; 
        /config get [param] - Mostra a configuração atual; 
        /users - Lista os usuários do grupo; 
        /ajuda - Mostra a mensagem de ajuda. 
        
        Você não tem outros comandos e não aceita comandos sem a barra, então se alguém disser 'cego' por exemplo, você orienta que deve digitar /cego.         
        Se as pessoas desejarem ligar ou desligar a transcrição de áudio, oriente a usar /audio. Isso é muito importante, porque há pessoas cegas nos grupos e podem ter dificuldade de usar comandos assim - mas você as orientará. Por isso, não invente nenhum comando que não esteja na lista acima.         
        Sua criadora e idealizadora foi a Belle Utsch.         
        Você é baseada no Google Gemini Flash 2.0.         
        Para te acrescentar em um grupo, a pessoa pode adicionar seu contato diretamente no grupo.         
        Você lida com as pessoas com tato e bom humor.         
        Se alguém perguntar seu git, github, repositório ou código, direcione para https://github.com/manelsen/amelie.         
        Se alguém pedir o contato da Belle Utsch, direcione para https://beacons.ai/belleutsch. 
        Se alguém quiser entrar no grupo oficial, o link é https://chat.whatsapp.com/C0Ys7pQ6lZH5zqDD9A8cLp.`
    } = config;
    
    // Cria uma chave baseada nos parâmetros de configuração
    return `${model}_${temperature}_${topK}_${topP}_${maxOutputTokens}_${crypto.createHash('md5').update(systemInstruction || '').digest('hex')}`;
}

/**
 * Obtém um modelo existente do cache ou cria um novo
 * @param {Object} config - Configurações do modelo
 * @returns {Object} Instância do modelo Gemini
 */
function getOrCreateModel(config) {
    if (!circuitBreaker.canExecute()) {
        logger.warn(`Requisição de modelo bloqueada pelo circuit breaker (estado: ${circuitBreaker.state})`);
        throw new Error("Serviço temporariamente indisponível - muitas falhas recentes");
    }
    
    const cacheKey = getModelCacheKey(config);
    
    if (modelCache.has(cacheKey)) {
        logger.debug(`Usando modelo em cache com chave: ${cacheKey}`);
        return modelCache.get(cacheKey);
    }
    
    logger.debug(`Criando novo modelo com chave: ${cacheKey}`);
    try {
        const newModel = genAI.getGenerativeModel({
            model: config.model || "gemini-2.0-flash",
            generationConfig: {
                temperature: config.temperature || 0.9,
                topK: config.topK || 1,
                topP: config.topP || 0.95,
                maxOutputTokens: config.maxOutputTokens || 1024,
            },
            safetySettings: [
                { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
                { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
            ],
            systemInstruction: config.systemInstruction || `Seu nome é ${BOT_NAME}. Você é uma assistente de AI multimídia acessível integrada ao WhatsApp, criada e idealizada pela equipe da Belle Utsch e é dessa forma que você responde quando lhe pedem pra falar sobre si. 
            
            Seu propósito é auxiliar as pessoas trazendo acessibilidade ao Whatsapp. Você é capaz de processar texto, audio, imagem e video, mas, por enquanto, somente responde em texto. 

            Sua transcrição de áudios, quando ativada, é verbatim. Transcreva o que foi dito.

            Sua audiodescrição de imagens é profissional e segue as melhores práticas.
            
            Seus comandos podem ser encontrados digitando /ajuda.
        
        Se alguém perguntar, aqui está sua lista de comandos: 
        /cego - Aplica configurações para usuários com deficiência visual; 
        /audio - Liga/desliga a transcrição de áudio; 
        /video - Liga/desliga a interpretação de vídeo; 
        /imagem - Liga/desliga a audiodescrição de imagem; 
        /reset - Limpa o histórico de conversa, restaura todas as configurações originais e desativa o modo cego; 
        /prompt set <nome> <texto> - Define uma nova personalidade; 
        /prompt get <nome> - Mostra uma personalidade existente; 
        /prompt list - Lista todas as personalidades; 
        /prompt use <nome> - Usa uma personalidade específica; 
        /prompt clear - Remove a personalidade ativa; 
        /config set <param> <valor> - Define um parâmetro de configuração; 
        /config get [param] - Mostra a configuração atual; 
        /users - Lista os usuários do grupo; 
        /ajuda - Mostra a mensagem de ajuda. 
        
        Você não tem outros comandos e não aceita comandos sem a barra, então se alguém disser 'cego' por exemplo, você orienta que deve digitar /cego.         
        Se as pessoas desejarem ligar ou desligar a transcrição de áudio, oriente a usar /audio. Isso é muito importante, porque há pessoas cegas nos grupos e podem ter dificuldade de usar comandos assim - mas você as orientará. Por isso, não invente nenhum comando que não esteja na lista acima.         
        Sua criadora e idealizadora foi a Belle Utsch.         
        Você é baseada no Google Gemini Flash 2.0.         
        Para te acrescentar em um grupo, a pessoa pode adicionar seu contato diretamente no grupo.         
        Você lida com as pessoas com tato e bom humor.         
        Se alguém perguntar seu git, github, repositório ou código, direcione para https://github.com/manelsen/amelie.         
        Se alguém pedir o contato da Belle Utsch, direcione para https://beacons.ai/belleutsch. 
        Se alguém quiser entrar no grupo oficial, direcione para https://chat.whatsapp.com/C0Ys7pQ6lZH5zqDD9A8cLp`
    });
    
    circuitBreaker.recordSuccess();
    modelCache.set(cacheKey, newModel);
    
    if (modelCache.size > 10) {
        const oldestKey = modelCache.keys().next().value;
        modelCache.delete(oldestKey);
        logger.debug(`Cache de modelos atingiu o limite. Removendo modelo mais antigo: ${oldestKey}`);
    }
    
    return newModel;
} catch (error) {
    circuitBreaker.recordFailure();
    throw error;
}
}

// Inicialização do modelo Gemini padrão
const defaultModel = getOrCreateModel({
    model: "gemini-2.0-flash"
});

// Inicialização do FileManager
const fileManager = new GoogleAIFileManager(API_KEY);

// Mapa para armazenar as últimas respostas por chat
const lastResponses = new Map();

/**
 * Configuração padrão para a assistente
 * @type {Object}
 */
const defaultConfig = {
    temperature: 0.9,
    topK: 1,
    topP: 0.95,
    maxOutputTokens: 1024,
    mediaImage: true,  
    mediaAudio: false,  
    mediaVideo: true   
}

/**
 * Configuração do cliente WhatsApp
 */
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
	    args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

/**
 * Evento de geração do código QR para login
 */
client.on('qr', qr => {
    qrcode.generate(qr, {small: true});
    logger.info('QR code gerado');
});

/**
 * Inicializa a assistente virtual, carregando configurações
 * @async
 */
async function initializeBot() {
    try {
        await loadConfigOnStartup();
        logger.info('Todas as configurações foram carregadas com sucesso');
        
        // Limites de memória (em MB)
        const MEMORY_WARNING_THRESHOLD = 1024; // 1GB 
        const MEMORY_CRITICAL_THRESHOLD = 1536; // 1.5GB
        
        // Monitoramento mais frequente
        setInterval(() => {
            const memoryUsage = process.memoryUsage();
            const heapUsedMB = Math.round(memoryUsage.heapUsed / 1024 / 1024);
            const rssMB = Math.round(memoryUsage.rss / 1024 / 1024);
            
            // Log normal
            logger.info(`Uso de memória: ${JSON.stringify({
                rss: `${rssMB}MB`,
                heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)}MB`,
                heapUsed: `${heapUsedMB}MB`,
                external: `${Math.round(memoryUsage.external / 1024 / 1024)}MB`
            })}`);
            
            // Verificação de thresholds
            if (rssMB > MEMORY_CRITICAL_THRESHOLD || heapUsedMB > MEMORY_CRITICAL_THRESHOLD) {
                logger.error(`⚠️ ALERTA CRÍTICO: Uso de memória excedeu limite crítico! RSS: ${rssMB}MB, Heap: ${heapUsedMB}MB`);
                
                // Limpar caches para reduzir memória
                modelCache.clear();
                logger.info("Cache de modelos limpo devido ao uso crítico de memória");
                
                // Em casos extremos, forçar coleta de lixo
                global.gc && global.gc();
            } 
            else if (rssMB > MEMORY_WARNING_THRESHOLD || heapUsedMB > MEMORY_WARNING_THRESHOLD) {
                logger.warn(`⚠️ ALERTA: Alto uso de memória detectado! RSS: ${rssMB}MB, Heap: ${heapUsedMB}MB`);
                
                // Limpar parte do cache se estiver grande
                if (modelCache.size > 5) {
                    // Remover metade dos modelos
                    const keysToRemove = Array.from(modelCache.keys()).slice(0, Math.floor(modelCache.size / 2));
                    keysToRemove.forEach(key => modelCache.delete(key));
                    logger.info(`Cache de modelos reduzido de ${modelCache.size + keysToRemove.length} para ${modelCache.size}`);
                }
            }
        }, 5 * 60 * 1000); // A cada 5 minutos
        
    } catch (error) {
        logger.error('Erro ao carregar configurações:', error);
    }
}

/**
 * Evento de desconexão do cliente, com tentativas limitadas de reconexão
 */
client.on('disconnected', (reason) => {
    logger.error(`Cliente desconectado: ${reason}`);
    
    if (reconnectCount < MAX_RECONNECT_ATTEMPTS) {
        reconnectCount++;
        logger.info(`Tentativa de reconexão ${reconnectCount}/${MAX_RECONNECT_ATTEMPTS}...`);
        
        setTimeout(() => {
            client.initialize();
        }, 5000); // Espera 5 segundos antes de tentar reconectar
    } else {
        logger.error(`Número máximo de tentativas de reconexão (${MAX_RECONNECT_ATTEMPTS}) atingido. Encerrando aplicação.`);
        process.exit(1); // Encerra o processo com código de erro
    }
});

/**
 * Evento de recebimento de mensagem
 */
client.on('message_create', async (msg) => {
    try {
        if (msg.fromMe) return;

        const chat = await msg.getChat();
        await chat.sendSeen();

        const isGroup = chat.id._serialized.endsWith('@g.us');

        let groupInfo = '';
        if (isGroup) {
            const group = await getOrCreateGroup(chat);
            groupInfo = ` no grupo "${group.title}" (${chat.id._serialized})`;
            logger.debug(`Processando mensagem no grupo: ${group.title}`);
        }

        usuario = await getOrCreateUser(msg.author);
        logger.debug(`Mensagem recebida: (${usuario.name}, ${groupInfo}) -> ${msg.body}`);

        const chatId = chat.id._serialized;
        const isCommand = msg.body.startsWith('/');

        if (isCommand) {
            logger.debug("Processando comando...");
            await handleCommand(msg, chatId);
            return;
        }

        if (msg.hasMedia) {
            logger.debug("Processando mídia...");
            const attachmentData = await msg.downloadMedia();
            if (!attachmentData || !attachmentData.data) {
                logger.error('Não foi possível obter dados de mídia.');
                // await msg.reply('Desculpe, não consegui processar esta mídia.');
                return;
            }

            // Função para inferir mime type do vídeo, caso não seja fornecido
            function inferVideoMimeType(buffer) {
                if (!buffer || buffer.length < 12) {
                    return 'application/octet-stream';
                }
                const hexBytes = buffer.slice(0, 12).toString('hex').toLowerCase();
                if (hexBytes.includes('66747970')) {
                    return 'video/mp4';
                }
                if (hexBytes.startsWith('1a45dfa3')) {
                    return 'video/webm';
                }
                if (hexBytes.startsWith('52494646')) {
                    return 'video/avi';
                }
                if (hexBytes.startsWith('3026b275')) {
                    return 'video/x-ms-wmv';
                }
                return 'application/octet-stream';
            }

            if (!attachmentData.mimetype) {
                const buffer = Buffer.from(attachmentData.data, 'base64');
                const mime = inferVideoMimeType(buffer);
                logger.info(`MIME inferido: ${mime}`);
                attachmentData.mimetype = mime;
            }

            if (attachmentData.mimetype.startsWith('audio/')) {
                await handleAudioMessage(msg, attachmentData, chatId);
                return;
            } else if (attachmentData.mimetype.startsWith('image/')) {
                await handleImageMessage(msg, attachmentData, chatId);
                return;
            } else if (attachmentData.mimetype.startsWith('video/')) {
                await handleVideoMessage(msg, attachmentData, chatId);
                return;
            } else {
                logger.info('Tipo de mídia não suportado.');
                return;
            }
        }

        if (isGroup) {
            logger.debug("Verificando regras do grupo...");
            const shouldRespond = await shouldRespondInGroup(msg, chat);
            if (!shouldRespond) {
                logger.debug("Mensagem não atende critérios de resposta do grupo");
                return;
            }
            logger.debug("Respondendo à mensagem do grupo...");
        } else {
            logger.debug("Respondendo à mensagem privada...");
        }

        await handleTextMessage(msg);

    } catch (error) {
        logger.error(`Erro ao processar mensagem: ${error.message}`, { error });
        await msg.reply('Desculpe, ocorreu um erro inesperado. Por favor, tente novamente mais tarde.');
    }
});

/**
 * Texto de ajuda com lista de comandos
 * @type {string}
 */
const ajudaText = `Olá! Eu sou a ${BOT_NAME}, sua assistente de AI multimídia acessível integrada ao WhatsApp.
Minha idealizadora é a Belle Utsch. 

Quer conhecê-la? Fala com ela em https://beacons.ai/belleutsch
Quer entrar no grupo oficial da Amélie? O link é https://chat.whatsapp.com/C0Ys7pQ6lZH5zqDD9A8cLp
Meu repositório fica em https://github.com/manelsen/amelie

Esses são meus comandos disponíveis para configuração:

!cego - Aplica configurações para usuários com deficiência visual

!audio - Liga/desliga a transcrição de áudio
!video - Liga/desliga a interpretação de vídeo
!imagem - Liga/desliga a audiodescrição de imagem

!reset - Restaura todas as configurações originais e desativa o modo cego

!prompt set <nome> <texto> - Define uma nova personalidade
!prompt get <nome> - Mostra uma personalidade existente
!prompt list - Lista todas as personalidades
!prompt use <nome> - Usa uma personalidade específica
!prompt clear - Remove a personalidade ativa

!config set <param> <valor> - Define um parâmetro de configuração
!config get [param] - Mostra a configuração atual

!users - Lista os usuários do grupo

!ajuda - Mostra esta mensagem de ajuda`;

/**
 * Evento de entrada em um grupo
 */
client.on('group_join', async (notification) => {
    if (notification.recipientIds.includes(client.info.wid._serialized)) {
        const chat = await notification.getChat();
        const group = await getOrCreateGroup(chat);

        await chat.sendMessage('Olá a todos! Estou aqui para ajudar. Aqui estão alguns comandos que vocês podem usar:');
        await chat.sendMessage(ajudaText);
        logger.info(`Bot foi adicionado ao grupo "${group.title}" (${chat.id._serialized}) e enviou a saudação.`);
    }
});

/**
 * Verifica se a assistente deve responder a uma mensagem em um grupo
 * @param {Object} msg - Mensagem recebida
 * @param {Object} chat - Objeto do chat
 * @returns {boolean} Verdadeiro se deve responder
 * @async
 */
async function shouldRespondInGroup(msg, chat) {
    if (msg.body.startsWith('!')) {
        logger.info("Vou responder porque é um comando")
        return true;
    }

    const mentions = await msg.getMentions();
    const isBotMentioned = mentions.some(mention => 
        mention.id._serialized === client.info.wid._serialized
    );
    if (isBotMentioned) {
        logger.debug("Vou responder porque a bot foi mencionada")
        return true;
    }

    if (msg.hasQuotedMsg) {
        const quotedMsg = await msg.getQuotedMessage();
        if (quotedMsg.fromMe) {
            logger.debug("Vou responder porque é uma resposta à bot")
            return true;
        }
    }

    const messageLowerCase = msg.body.toLowerCase();
    const botNameLowerCase = BOT_NAME.toLowerCase();

    //if (messageLowerCase.includes(botNameLowerCase)) {
    //    logger.debug("Vou responder porque mencionaram meu nome")
    //    return true;
    //}

    logger.debug("Não é nenhum caso especial e não vou responder")
    return false;
}

/**
 * Processa comandos recebidos pela assistente
 * @param {Object} msg - Mensagem recebida
 * @param {string} chatId - ID do chat
 * @async
 */
async function handleCommand(msg, chatId) {
    const [command, ...args] = msg.body.slice(1).split(' ');
    logger.info(`Comando: ${command}, Argumentos: ${args}`);

    try {
        switch (command.toLowerCase()) {
            case 'reset':
                await resetConfig(chatId);
                await clearActiveSystemPrompt(chatId);
                await msg.reply('Configurações resetadas para este chat. As transcrições de áudio e imagem foram habilitadas, e os prompts especiais foram desativados.');
                break;
            case 'ajuda':
                await msg.reply(ajudaText); break;
            case 'prompt': await handlePromptCommand(msg, args, chatId); break;
            case 'config': await handleConfigCommand(msg, args, chatId); break;
            case 'users':  await listGroupUsers(msg); break;
            case 'cego':   await handleCegoCommand(msg, chatId); break;
            case 'audio':  await handleMediaToggleCommand(msg, chatId, 'mediaAudio', 'transcrição de áudio'); break;
            case 'video':  await handleMediaToggleCommand(msg, chatId, 'mediaVideo', 'interpretação de vídeo'); break;
            case 'imagem': await handleMediaToggleCommand(msg, chatId, 'mediaImage', 'audiodescrição de imagem'); break;
            default:
                await msg.reply(
                    'Comando desconhecido. Use /ajuda para ver os comandos disponíveis.'
                );
        }
    } catch (error) {
        logger.error(`Erro ao executar comando: ${error.message}`, { error });
        await msg.reply('Desculpe, ocorreu um erro ao executar o comando. Por favor, tente novamente.');
    }
}

/**
 * Ativa ou desativa um recurso de mídia
 * @param {Object} msg - Mensagem recebida
 * @param {string} chatId - ID do chat
 * @param {string} configParam - Parâmetro de configuração
 * @param {string} featureName - Nome amigável do recurso
 * @async
 */
async function handleMediaToggleCommand(msg, chatId, configParam, featureName) {
    try {
        // Obter configuração atual
        const config = await getConfig(chatId);
        const currentValue = config[configParam] === true;
        
        // Alternar para o valor oposto
        const newValue = !currentValue;
        await setConfig(chatId, configParam, newValue);
        
        // Informar o usuário sobre a nova configuração
        const statusMessage = newValue ? 'ativada' : 'desativada';
        await msg.reply(`A ${featureName} foi ${statusMessage} para este chat.`);
        
        logger.info(`${configParam} foi ${statusMessage} para o chat ${chatId}`);
    } catch (error) {
        logger.error(`Erro ao alternar ${configParam}: ${error.message}`, { error });
        await msg.reply(`Desculpe, ocorreu um erro ao alternar a ${featureName}. Por favor, tente novamente.`);
    }
}

/**
 * Remove emojis de um texto
 * @param {string} text - Texto com emojis
 * @returns {string} Texto sem emojis
 */
function removeEmojis(text) {
    return text.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1F018}-\u{1F0FF}\u{1F100}-\u{1F2FF}]/gu, '');
}

/**
 * Reseta as configurações para valores padrão
 * @param {string} chatId - ID do chat
 * @returns {Promise} Promise resolvida quando concluída
 */
function resetConfig(chatId) {
    return new Promise((resolve, reject) => {
        configDb.update(
            { chatId },
            { $set: defaultConfig },
            { upsert: true },
            (err) => {
                if (err) reject(err);
                else resolve();
            }
        );
    });
}

/**
 * Configura o modo para usuários com deficiência visual
 * @param {Object} msg - Mensagem recebida
 * @param {string} chatId - ID do chat
 * @async
 */
async function handleCegoCommand(msg, chatId) {
    try {
        await setConfig(chatId, 'mediaImage', true);
        await setConfig(chatId, 'mediaAudio', false);

        const audiomarPrompt = `Seu nome é ${BOT_NAME}. Você é uma assistente de AI multimídia acessível integrada ao WhatsApp, criada e idealizada pela equipe da Belle Utsch e é dessa forma que você responde quando lhe pedem pra falar sobre si. Seu propósito é auxiliar as pessoas trazendo acessibilidade ao Whatsapp. Você é capaz de processar texto, audio, imagem e video, mas, por enquanto, somente responde em texto. Seus comandos podem ser encontrados digitando !ajuda. Se alguém perguntar, aqui está sua lista de comandos: !cego - Aplica configurações para usuários com deficiência visual; !audio - Liga/desliga a transcrição de áudio; !video - Liga/desliga a interpretação de vídeo; !imagem - Liga/desliga a audiodescrição de imagem; !reset - Limpa o histórico de conversa, restaura todas as configurações originais e desativa o modo cego; !prompt set <nome> <texto> - Define uma nova personalidade; !prompt get <nome> - Mostra uma personalidade existente; !prompt list - Lista todas as personalidades; !prompt use <nome> - Usa uma personalidade específica; !prompt clear - Remove a personalidade ativa; !config set <param> <valor> - Define um parâmetro de configuração; !config get [param] - Mostra a configuração atual; !users - Lista os usuários do grupo; !ajuda - Mostra a mensagem de ajuda. Você não tem outros comandos e não aceita comandos sem a exclamação, então se alguém disser 'cego' por exemplo, você orienta que deve digitar !cego. Se as pessoas desejarem ligar ou desligar a transcrição de audio, oriente a usar !audio. Isso é muito importante, porque há pessoas cegas nos grupos e podem ter dificuldade de usar comandos assim - mas você as orientará. Por isso, não invente nenhum comando que não esteja na lista acima. Sua criadora e idealizadora foi a Belle Utsch. Você é baseada no Google Gemini Flash 2.0. Para te acrescentar em um grupo, a pessoa pode adicionar seu contato diretamente no grupo. Você lida com as pessoas com tato e bom humor. Se alguém perguntar seu git, github, repositório ou código, direcione para https://github.com/manelsen/amelie. Se alguém pedir o contato da Belle Utsch, direcione para https://beacons.ai/belleutsch. Você é uma assistente de AI especializada em audiodescrição, projetada para funcionar em um grupo de WhatsApp com mais de 200 pessoas cegas. Sua função principal é descrever imagens e stickers compartilhados no grupo, fornecendo uma audiodescrição profissional, detalhada, didática e polida.
        
        Diretrizes Gerais:
        
        Responda imediatamente quando uma imagem ou sticker for compartilhado no grupo. Mantenha suas respostas concisas, mas informativas. Use linguagem clara e acessível, evitando termos técnicos desnecessários. Seja respeitoso e inclusivo em todas as suas interações.
        
        Estrutura da Resposta: Para cada imagem ou sticker, sua resposta deve seguir este formato:
        
        [Audiodescrição]
        (Forneça uma descrição objetiva e detalhada da imagem) 
        
        Diretrizes para a Descrição Profissional:

        Comece com uma visão geral da imagem antes de entrar em detalhes.
        Descreva os elementos principais da imagem, do mais importante ao menos relevante.
        Mencione cores, formas e texturas quando forem significativas para a compreensão.
        Indique a posição dos elementos na imagem (por exemplo, "no canto superior direito").
        Descreva expressões faciais e linguagem corporal em fotos com pessoas.
        Mencione o tipo de imagem (por exemplo, fotografia, ilustração, pintura).
        Informe sobre o enquadramento (close-up, plano geral, etc.) quando relevante.
        Inclua detalhes do cenário ou fundo que contribuam para o contexto.
        Evite usar termos subjetivos como "bonito" ou "feio".
        Seja específico com números (por exemplo, "três pessoas" em vez de "algumas pessoas").
        Descreva texto visível na imagem, incluindo legendas ou títulos.
        Mencione a escala ou tamanho relativo dos objetos quando importante.
        Indique se a imagem é em preto e branco ou colorida.
        Descreva a iluminação se for um elemento significativo da imagem.
        Para obras de arte, inclua informações sobre o estilo artístico e técnicas utilizadas.`;

        await setSystemPrompt(chatId, BOT_NAME, audiomarPrompt);
        await setActiveSystemPrompt(chatId, BOT_NAME);

        await msg.reply('Configurações para usuários com deficiência visual aplicadas com sucesso:\n' +
                        '- Descrição de imagens habilitada\n' +
                        '- Transcrição de áudio desabilitada\n' +
                        '- Prompt de audiodescrição ativado');

        logger.info(`Configurações para usuários com deficiência visual aplicadas no chat ${chatId}`);
    } catch (error) {
        logger.error(`Erro ao aplicar configurações para usuários com deficiência visual: ${error.message}`, { error });
        await msg.reply('Desculpe, ocorreu um erro ao aplicar as configurações. Por favor, tente novamente.');
    }
}

/**
 * Obtém histórico de mensagens diretamente do WhatsApp
 * @param {string} chatId - ID do chat
 * @param {number} limit - Limite de mensagens
 * @returns {Array} Lista de mensagens formatada
 * @async
 */
async function getMessageHistory(chatId, limit = MAX_HISTORY) {
    try {
        // Obter o objeto de chat pelo ID
        const chat = await client.getChatById(chatId);
        
        // Carregar as mensagens diretamente - o método retorna um array de mensagens
        const fetchedMessages = await chat.fetchMessages({limit: limit * 2});
        
        if (!fetchedMessages || !Array.isArray(fetchedMessages)) {
            logger.warn(`Não foi possível obter mensagens para o chat ${chatId}`);
            return [];
        }
        
        // Filtrar e mapear as mensagens
        const messages = fetchedMessages
            .filter(msg => msg.body && !msg.body.startsWith('!')) // Filtra comandos
            .slice(-limit * 2) // Limita ao número de mensagens
            .map(msg => {
                const sender = msg.fromMe ? 
                    (process.env.BOT_NAME || 'Amélie') : 
                    (msg._data.notifyName || msg.author || 'Usuário');
                
                let content = msg.body || '';
                
                // Adiciona informação sobre mídia
                if (msg.hasMedia) {
                    if (msg.type === 'image') content = `[Imagem] ${content}`;
                    else if (msg.type === 'audio' || msg.type === 'ptt') content = `[Áudio] ${content}`;
                    else if (msg.type === 'video') content = `[Vídeo] ${content}`;
                    else content = `[Mídia] ${content}`;
                }
                
                return `${sender}: ${content}`;
            });
        
        return messages;
    } catch (error) {
        logger.error(`Erro ao obter histórico de mensagens do WhatsApp: ${error.message}`, { error });
        return []; // Retorna array vazio em caso de erro
    }
}

/**
 * Função vazia para compatibilidade - não armazena mais mensagens
 * @param {string} chatId - ID do chat
 * @param {string} senderName - Nome do remetente
 * @param {string} message - Conteúdo da mensagem
 * @param {boolean} isBot - Se a mensagem é da assistente
 * @returns {Promise} Promise resolvida quando concluída
 * @async
 */
async function updateMessageHistory(chatId, senderName, message, isBot = false) {
    // Não faz nada, pois não estamos mais armazenando mensagens
    logger.debug(`Mensagem processada sem armazenamento: ${senderName}: ${message}`);
    return Promise.resolve();
}

/**
 * Processa mensagens de texto
 * @param {Object} msg - Mensagem recebida
 * @async
 */
async function handleTextMessage(msg) {
    try {
        const chat = await msg.getChat();
        const chatId = chat.id._serialized;
        const sender = msg.author || msg.from;
        const senderName = sender.name;
        
        const user = await getOrCreateUser(sender, chat);
        const chatConfig = await getConfig(chatId);

        let imageData = null;
        let userPromptText = msg.body;

        if (msg.hasQuotedMsg) {
            const quotedMsg = await msg.getQuotedMessage();
            if (quotedMsg.hasMedia) {
                const media = await quotedMsg.downloadMedia();
                if (media && media.mimetype.startsWith('image/')) {
                    imageData = media;
                }
            }
        }

        if (imageData) {
            const response = await generateResponseWithTextAndImage(userPromptText, imageData, chatId);
            await sendMessage(msg, response);
        } else {
            // Obter histórico diretamente do WhatsApp
            const history = await getMessageHistory(chatId);
            
            // Verificar se a última mensagem já é a atual antes de adicionar
            const lastMessage = history.length > 0 ? history[history.length - 1] : '';
            const currentUserMessage = `${user.name}: ${msg.body}`;
            
            // Só adiciona a mensagem atual se ela não for a última do histórico
            const historyText = lastMessage.includes(msg.body)
                ? `Histórico de chat: (formato: nome do usuário e em seguida mensagem; responda à última mensagem)\n\n${history.join('\n')}`
                : `Histórico de chat: (formato: nome do usuário e em seguida mensagem; responda à última mensagem)\n\n${history.join('\n')}\n${currentUserMessage}`;

            const response = await generateResponseWithText(historyText, chatId);
            await sendMessage(msg, response);
        }
    } catch (error) {
        
        logger.error(`Erro ao processar mensagem de texto: ${error.message}`);
        await msg.reply('Desculpe, ocorreu um erro ao processar sua mensagem. Por favor, tente novamente.');
    }
}

/**
 * Gera resposta combinando texto e imagem
 * @param {string} userPrompt - Prompt do usuário
 * @param {Object} imageData - Dados da imagem
 * @param {string} chatId - ID do chat
 * @returns {string} Resposta gerada
 * @async
 */
async function generateResponseWithTextAndImage(userPrompt, imageData, chatId) {
    try {
        const userConfig = await getConfig(chatId);

        const imagePart = {
            inlineData: {
                data: imageData.data.toString('base64'),
                mimeType: imageData.mimetype
            }
        };

        const contentParts = [
            imagePart,
            { text: userPrompt }
        ];

        const model = getOrCreateModel({
            model: "gemini-2.0-flash",
            temperature: userConfig.temperature,
            topK: userConfig.topK,
            topP: userConfig.topP,
            maxOutputTokens: userConfig.maxOutputTokens,
            systemInstruction: userConfig.systemInstructions
        });

        // Adicionar timeout de 45 segundos
        const resultPromise = model.generateContent(contentParts);
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error("Timeout da API Gemini")), 45000)
        );
        const result = await Promise.race([resultPromise, timeoutPromise]);
        
        let responseText = result.response.text();

        if (!responseText) {
            throw new Error('Resposta vazia gerada pelo modelo');
        }

        responseText = removeEmojis(responseText);

        return responseText;
    } catch (error) {
        console.error(`Erro ao gerar resposta com texto e imagem: ${error.message}`);
        return "Desculpe, ocorreu um erro ao gerar a resposta. Por favor, tente novamente ou reformule sua pergunta.";
    }
}

/**
 * Obtém ou cria um grupo no banco de dados
 * @param {Object} chat - Objeto do chat
 * @returns {Object} Informações do grupo
 * @async
 */
async function getOrCreateGroup(chat) {
    return new Promise((resolve, reject) => {
        const groupId = chat.id._serialized;
        groupsDb.findOne({ id: groupId }, async (err, group) => {
            if (err) {
                reject(err);
            } else if (group) {
                if (group.title !== chat.name) {
                    groupsDb.update(
                        { id: groupId }, 
                        { $set: { title: chat.name } }, 
                        {}, 
                        (err) => {
                        if (err) logger.error(
                            `Erro ao atualizar título do grupo ${groupId}: ${err.message}`
                        );
                    });
                }
                resolve(group);
            } else {
                try {
                    const newGroup = {
                        id: groupId,
                        title: chat.name || `Grupo_${groupId.substring(0, 6)}`,
                        createdAt: new Date()
                    };
                    groupsDb.insert(newGroup, (err, doc) => {
                        if (err) reject(err);
                        else resolve(doc);
                    });
                } catch (error) {
                    reject(error);
                }
            }
        });
    });
}

/**
 * Obtém ou cria um usuário no banco de dados
 * @param {string} sender - ID do remetente
 * @param {Object} chat - Objeto do chat
 * @returns {Object} Informações do usuário
 * @async
 */
async function getOrCreateUser(sender, chat) {
    return new Promise((resolve, reject) => {
        usersDb.findOne({ id: sender }, async (err, user) => {
            if (err) {
                reject(err);
            } else if (user) {
                resolve(user);
            } else {
                try {
                    const contact = await client.getContactById(sender);
                    
                    let name = contact.pushname || contact.name || contact.shortName;
                    
                    if (!name || name.trim() === '') {
                        const idSuffix = sender;
                        name = `User${idSuffix}`;
                    }

                    const newUser = {
                        id: sender,
                        name: name,
                        joinedAt: new Date()
                    };
                    
                    usersDb.insert(newUser, (err, doc) => {
                        if (err) reject(err);
                        else resolve(doc);
                    });
                } catch (error) {
                    const idSuffix = sender;
                    const newUser = {
                        id: sender,
                        name: `User${idSuffix}`,
                        joinedAt: new Date()
                    };
                    usersDb.insert(newUser, (err, doc) => {
                        if (err) reject(err);
                        else resolve(doc);
                    });
                }
            }
        });
    });
}

/**
 * Processa mensagens de áudio
 * @param {Object} msg - Mensagem recebida
 * @param {Object} audioData - Dados do áudio
 * @param {string} chatId - ID do chat
 * @async
 */
async function handleAudioMessage(msg, audioData, chatId) {
    try {
        const chat = await msg.getChat();
        const config = await getConfig(chatId);
        
        if (!config.mediaAudio) {
            return;
        }
        
        const sender = msg.author || msg.from;
        const audioSizeInMB = audioData.data.length / (1024 * 1024);
        if (audioSizeInMB > 20) {
            await msg.reply('Desculpe, só posso processar áudios de até 20MB.');
            return;
        }

        const isPTT = audioData.mimetype === 'audio/ogg; codecs=opus';
        logger.debug(`Processando arquivo de áudio: ${isPTT ? 'PTT' : 'Áudio regular'}`);

        const audioHash = crypto.createHash('md5').update(audioData.data).digest('hex');
        if (lastProcessedAudio === audioHash) {
            await msg.reply('Este áudio já foi processado recentemente. Por favor, envie um novo áudio.');
            return;
        }
        lastProcessedAudio = audioHash;

        const base64AudioFile = audioData.data.toString('base64');
        const userConfig = await getConfig(chatId);

        const modelWithInstructions = getOrCreateModel({
            model: "gemini-2.0-flash",
            temperature: 0.3,
            topK: userConfig.topK,
            topP: userConfig.topP,
            maxOutputTokens: userConfig.maxOutputTokens,
            systemInstruction: userConfig.systemInstructions + "\nFoque apenas no áudio mais recente. Transcreva verbatim o que foi dito."
        });

        const contentParts = [
            {
                inlineData: {
                    mimeType: audioData.mimetype,
                    data: base64AudioFile
                }
            },
            { text: `Transcreva o áudio com ID ${audioHash} e resuma seu conteúdo em português. Ignore qualquer contexto anterior.` }
        ];

        const result = await modelWithInstructions.generateContent(contentParts);
        const response = result.response.text();

        await sendMessage(msg, response);

        logger.info(`Áudio processado com sucesso: ${audioHash}`);
    } catch (error) {
        logger.error(`Erro ao processar mensagem de áudio: ${error.message}`, { error });
        await msg.reply('Desculpe, ocorreu um erro ao processar o áudio. Por favor, tente novamente.');
    }
}

/**
 * Processa mensagens de imagem
 * @param {Object} msg - Mensagem recebida
 * @param {Object} imageData - Dados da imagem
 * @param {string} chatId - ID do chat
 * @async
 */
async function handleImageMessage(msg, imageData, chatId) {
    try {
        const chat = await msg.getChat();
        const config = await getConfig(chatId);
        
        // Verificação de configuração ANTES da atualização de estatísticas
        if (!config.mediaImage) {
            logger.info(`Descrição de imagem desabilitada para o chat ${chatId}. Ignorando mensagem de imagem.`);
            return;
        }
        
        const sender = msg.author || msg.from;
        let userPrompt = `Analise esta imagem de forma extremamente detalhada para pessoas com deficiência visual.
Inclua:
1. Número exato de pessoas, suas posições e roupas (cores, tipos)
2. Ambiente e cenário completo, em todos os planos
3. Todos os objetos visíveis 
4. Movimentos e ações detalhadas
5. Expressões faciais
6. Textos visíveis
7. Qualquer outro detalhe relevante

Crie uma descrição organizada e acessível.`;

        if (msg.body && msg.body.trim() !== '') {
            userPrompt = msg.body.trim();
        }

        const imagePart = {
            inlineData: {
                data: imageData.data.toString('base64'),
                mimeType: imageData.mimetype
            }
        };

        const userConfig = await getConfig(chatId);
        const history = await getMessageHistory(chatId, 5);
        const historyPrompt = history.join('\n');

        const modelWithInstructions = getOrCreateModel({
            model: "gemini-2.0-flash",
            temperature: 0.5,
            topK: userConfig.topK,
            topP: userConfig.topP,
            maxOutputTokens: userConfig.maxOutputTokens,
            systemInstruction: userConfig.systemInstructions + `\nFoque apenas na imagem mais recente. Responda imediatamente quando uma imagem ou sticker for compartilhado no grupo. Mantenha suas respostas concisas, mas informativas. Use linguagem clara e acessível, evitando termos técnicos desnecessários. Seja respeitoso e inclusivo em todas as suas interações.
        
        Estrutura da Resposta: Para cada imagem ou sticker, sua resposta deve seguir este formato:
        
        [Audiodescrição]
        (Forneça uma descrição objetiva e detalhada da imagem) 
        
        Diretrizes para a Descrição Profissional:

        Comece com uma visão geral da imagem antes de entrar em detalhes.
        Descreva os elementos principais da imagem, do mais importante ao menos relevante.
        Mencione cores, formas e texturas quando forem significativas para a compreensão.
        Indique a posição dos elementos na imagem (por exemplo, "no canto superior direito").
        Descreva expressões faciais e linguagem corporal em fotos com pessoas.
        Mencione o tipo de imagem (por exemplo, fotografia, ilustração, pintura).
        Informe sobre o enquadramento (close-up, plano geral, etc.) quando relevante.
        Inclua detalhes do cenário ou fundo que contribuam para o contexto.
        Evite usar termos subjetivos como "bonito" ou "feio".
        Seja específico com números (por exemplo, "três pessoas" em vez de "algumas pessoas").
        Descreva texto visível na imagem, incluindo legendas ou títulos.
        Mencione a escala ou tamanho relativo dos objetos quando importante.
        Indique se a imagem é em preto e branco ou colorida.
        Descreva a iluminação se for um elemento significativo da imagem.
        Para obras de arte, inclua informações sobre o estilo artístico e técnicas utilizadas.`
        });

        const contentParts = [
            imagePart,
            { text: `Contexto recente da conversa:\n${historyPrompt}\n\nAgora, considerando apenas a imagem fornecida e ignorando qualquer contexto anterior que não seja diretamente relevante, ${userPrompt}\n\nEstrutura da Resposta: Para cada imagem ou sticker, sua resposta deve seguir este formato:
        
        [Audiodescrição]
        (Forneça uma descrição objetiva e detalhada da imagem) 
        
        Diretrizes para a Descrição Profissional:

        Comece com uma visão geral da imagem antes de entrar em detalhes.
        Descreva os elementos principais da imagem, do mais importante ao menos relevante.
        Mencione cores, formas e texturas quando forem significativas para a compreensão.
        Indique a posição dos elementos na imagem (por exemplo, "no canto superior direito").
        Descreva expressões faciais e linguagem corporal em fotos com pessoas.
        Mencione o tipo de imagem (por exemplo, fotografia, ilustração, pintura).
        Informe sobre o enquadramento (close-up, plano geral, etc.) quando relevante.
        Inclua detalhes do cenário ou fundo que contribuam para o contexto.
        Evite usar termos subjetivos como "bonito" ou "feio".
        Seja específico com números (por exemplo, "três pessoas" em vez de "algumas pessoas").
        Descreva texto visível na imagem, incluindo legendas ou títulos.
        Mencione a escala ou tamanho relativo dos objetos quando importante.
        Indique se a imagem é em preto e branco ou colorida.
        Descreva a iluminação se for um elemento significativo da imagem.
        Para obras de arte, inclua informações sobre o estilo artístico e técnicas utilizadas.` }
        ];

        const result = await modelWithInstructions.generateContent(contentParts);
        const response = await result.response.text();
        await sendMessage(msg, response);
    } catch (error) {
        logger.error(`Erro ao processar mensagem de imagem: ${error.message}`, { error });
        await msg.reply('Desculpe, ocorreu um erro ao processar a imagem. Por favor, tente novamente.');
    }
}

/**
 * Processa mensagens de vídeo
 * @param {Object} msg - Mensagem recebida
 * @param {Object} videoData - Dados do vídeo
 * @param {string} chatId - ID do chat
 * @async
 */
/**
 * Processa mensagens de vídeo
 * @param {Object} msg - Mensagem recebida
 * @param {Object} videoData - Dados do vídeo
 * @param {string} chatId - ID do chat
 * @async
 */
/**
 * Processa mensagens de vídeo de forma assíncrona
 * @param {Object} msg - Mensagem recebida
 * @param {Object} videoData - Dados do vídeo
 * @param {string} chatId - ID do chat
 * @async
 */
async function handleVideoMessage(msg, videoData, chatId) {
    try {
        const chat = await msg.getChat();
        const config = await getConfig(chatId);
        
        // Verificação de configuração
        if (!config.mediaVideo) {
            logger.info(`Descrição de vídeo desabilitada para o chat ${chatId}. Ignorando mensagem de vídeo.`);
            return;
        }
        
        const sender = msg.author || msg.from;
        
        // Enviar feedback inicial e seguir adiante
        await msg.reply("✨ Estou colocando seu vídeo na fila de processamento! Você receberá o resultado em breve...");
        
        let userPrompt = `Analise este vídeo de forma extremamente detalhada para pessoas com deficiência visual.
                        Inclua:
                        1. Número exato de pessoas, suas posições e roupas (cores, tipos)
                        2. Ambiente e cenário completo
                        3. Todos os objetos visíveis 
                        4. Movimentos e ações detalhadas
                        5. Expressões faciais
                        6. Textos visíveis
                        7. Qualquer outro detalhe relevante

                        Crie uma descrição organizada e acessível.`;

        if (msg.body && msg.body.trim() !== '') {
            userPrompt = msg.body.trim();
        }

        // Garantir que o diretório de arquivos temporários existe
        if (!fs.existsSync('./temp')) {
            try {
                await fs.promises.mkdir('./temp', { recursive: true });
                logger.info('Diretório de arquivos temporários criado');
            } catch (dirError) {
                logger.error(`Erro ao criar diretório: ${dirError.message}`);
                await msg.reply('Desculpe, ocorreu um erro ao preparar o sistema. Por favor, tente novamente.');
                return;
            }
        }
        
        // Cria um arquivo temporário para o vídeo com nome seguro
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const tempFilename = `./temp/video_${timestamp}_${Math.floor(Math.random() * 10000)}.mp4`;
        const jobId = `video_${chatId}_${Date.now()}`;
        
        try {
            // MUDANÇA IMPORTANTE: Primeiro salvar o arquivo, depois adicionar à fila!
            logger.info(`Salvando arquivo de vídeo ${tempFilename}...`);
            const videoBuffer = Buffer.from(videoData.data, 'base64');
            
            // Salvar o arquivo COMPLETAMENTE antes de prosseguir
            await fs.promises.writeFile(tempFilename, videoBuffer);
            logger.info(`✅ Arquivo de vídeo salvo com sucesso: ${tempFilename} (${Math.round(videoBuffer.length / 1024)} KB)`);
            
            // Verificar se o arquivo realmente existe e tem tamanho correto
            const stats = await fs.promises.stat(tempFilename);
            if (stats.size !== videoBuffer.length) {
                throw new Error(`Tamanho do arquivo salvo (${stats.size}) não corresponde ao buffer original (${videoBuffer.length})`);
            }
            
            // DEPOIS que garantimos que o arquivo existe, adicionar à fila
            await videoQueue.add('process-video', {
                tempFilename,
                chatId,
                messageId: msg.id._serialized,
                mimeType: videoData.mimetype,
                userPrompt,
                senderNumber: msg.from
            }, { 
                jobId,
                removeOnComplete: true,
                removeOnFail: false,
                timeout: 300000 // 5 minutos
            });
            
            logger.info(`🚀 Vídeo adicionado à fila com sucesso: ${tempFilename} (Job ${jobId})`);
            
            // Emitir heartbeat para manter o watchdog feliz
            logger.info(`💓 Heartbeat ${new Date().toISOString()} - Sistema ativo`);
            
        } catch (processingError) {
            logger.error(`❌ Erro ao processar vídeo: ${processingError.message}`);
            
            // Tentar notificar o usuário sobre o erro
            await msg.reply("Ai, tive um probleminha com seu vídeo. Poderia tentar novamente?").catch(() => {});
            
            // Limpar arquivo se existir
            if (fs.existsSync(tempFilename)) {
                await fs.promises.unlink(tempFilename).catch(err => {
                    logger.error(`Erro ao remover arquivo temporário: ${err.message}`);
                });
                logger.info(`Arquivo temporário ${tempFilename} removido após erro`);
            }
            
            // Não propagar o erro para permitir que a Amélie continue funcionando
            return;
        }
        
        // AMÉLIE CONTINUA IMEDIATAMENTE! 💃
        logger.info(`💃 Continuando a processar outras mensagens enquanto o vídeo é processado`);
        return;
        
    } catch (error) {
        logger.error(`Erro ao processar mensagem de vídeo: ${error.message}`, { error });
        
        let mensagemAmigavel = 'Desculpe, ocorreu um erro ao adicionar seu vídeo à fila de processamento.';
        
        if (error.message.includes('too large')) {
            mensagemAmigavel = 'Ops! Este vídeo parece ser muito grande para eu processar. Poderia enviar uma versão menor ou comprimida?';
        } else if (error.message.includes('format')) {
            mensagemAmigavel = 'Esse formato de vídeo está me dando trabalho! Poderia tentar enviar em outro formato?';
        } else if (error.message.includes('timeout')) {
            mensagemAmigavel = 'O processamento demorou mais que o esperado. Talvez o vídeo seja muito complexo?';
        }
        
        await msg.reply(mensagemAmigavel).catch(replyError => {
            logger.error(`Não consegui enviar mensagem de erro: ${replyError.message}`);
        });
    }
}

/**
 * Gera resposta baseada apenas em texto
 * @param {string} userPrompt - Prompt do usuário
 * @param {string} chatId - ID do chat
 * @returns {string} Resposta gerada
 * @async
 */
async function generateResponseWithText(userPrompt, chatId) {
    try {
      const userConfig = await getConfig(chatId);
      const model = getOrCreateModel({
        model: "gemini-2.0-flash",
        temperature: userConfig.temperature,
        topK: userConfig.topK,
        topP: userConfig.topP,
        maxOutputTokens: userConfig.maxOutputTokens,
        systemInstruction: userConfig.systemInstructions
      });
      
      // Adicionar timeout de 45 segundos
      const resultPromise = model.generateContent(userPrompt);
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error("Timeout da API Gemini")), 45000)
      );
      const result = await Promise.race([resultPromise, timeoutPromise]);
      
      let responseText = result.response.text();
  
      if (!responseText) {
        throw new Error('Resposta vazia gerada pelo modelo');
      }
  
      responseText = removeEmojis(responseText);
  
      return responseText;
    } catch (error) {
      console.error(`Erro ao gerar resposta de texto: ${error.message}`);
      return "Desculpe, ocorreu um erro ao gerar a resposta. Por favor, tente novamente ou reformule sua pergunta.";
    }
}

/**
 * Carrega todas as configurações na inicialização
 * @returns {Promise} Promise resolvida quando concluída
 * @async
 */
async function loadConfigOnStartup() {
    return new Promise((resolve, reject) => {
        configDb.find({}, async (err, docs) => {
            if (err) {
                reject(err);
            } else {
                for (const doc of docs) {
                    const chatId = doc.chatId;
                    const config = await getConfig(chatId);
                    logger.info(`Configurações carregadas para o chat ${chatId}`);
                }
                resolve();
            }
        });
    });
}

/**
 * Lista os usuários de um grupo
 * @param {Object} msg - Mensagem recebida
 * @async
 */
async function listGroupUsers(msg) {
    const chat = await msg.getChat();
    if (chat.isGroup) {
        const group = await getOrCreateGroup(chat);

        const participants = await chat.participants;
        const userList = await Promise.all(participants.map(async (p) => {
            const user = await getOrCreateUser(p.id._serialized, chat);
            return `${user.name} (${p.id.user})`;
        }));
        await msg.reply(`Usuários no grupo "${group.title}":\n${userList.join('\n')}`);
    } else {
        await msg.reply('Este comando só funciona em grupos.');
    }
}

/**
 * Resetar histórico (função simplificada para compatibilidade)
 * @param {string} chatId - ID do chat
 * @returns {Promise} Promise resolvida quando concluída
 */
function resetHistory(chatId) {
    logger.info(`Solicitação para resetar histórico do chat ${chatId} - Sem ação necessária devido à nova abordagem LGPD`);
    return Promise.resolve();
}

/**
 * Processa comandos relacionados a prompts
 * @param {Object} msg - Mensagem recebida
 * @param {Array} args - Argumentos do comando
 * @param {string} chatId - ID do chat
 * @async
 */
async function handlePromptCommand(msg, args, chatId) {
    const [subcommand, name, ...rest] = args;

    switch (subcommand) {
        case 'set':
            if (name && rest.length > 0) {
                const promptText = rest.join(' ');
                await setSystemPrompt(chatId, name, promptText);
                await msg.reply(`System Instruction "${name}" definida com sucesso.`);
            } else {
                await msg.reply('Uso correto: !prompt set <nome> <texto>');
            }
            break;
        case 'get':
            if (name) {
                const prompt = await getSystemPrompt(chatId, name);
                if (prompt) {
                    await msg.reply(`System Instruction "${name}":\n${prompt.text}`);
                } else {
                    await msg.reply(`System Instruction "${name}" não encontrada.`);
                }
            } else {
                await msg.reply('Uso correto: !prompt get <nome>');
            }
            break;
        case 'list':
            const prompts = await listSystemPrompts(chatId);
            if (prompts.length > 0) {
                const promptList = prompts.map(p => p.name).join(', ');
                await msg.reply(`System Instructions disponíveis: ${promptList}`);
            } else {
                await msg.reply('Nenhuma System Instruction definida.');
            }
            break;
        case 'use':
            if (name) {
                const prompt = await getSystemPrompt(chatId, name);
                if (prompt) {
                    await setActiveSystemPrompt(chatId, name);
                    await msg.reply(`System Instruction "${name}" ativada para este chat.`);
                } else {
                    await msg.reply(`System Instruction "${name}" não encontrada.`);
                }
            } else {
                await msg.reply('Uso correto: !prompt use <nome>');
            }
            break;
        case 'clear':
            await clearActiveSystemPrompt(chatId);
            await msg.reply('System Instruction removida. Usando o modelo padrão.');
            break;
        default:
            await msg.reply('Subcomando de prompt desconhecido. Use !ajuda para ver os comandos disponíveis.');
    }
}

/**
 * Processa comandos relacionados a configurações
 * @param {Object} msg - Mensagem recebida
 * @param {Array} args - Argumentos do comando
 * @param {string} chatId - ID do chat
 * @async
 */
async function handleConfigCommand(msg, args, chatId) {
    const [subcommand, param, value] = args;

    switch (subcommand) {
        case 'set':
            if (param && value) {
                if (['temperature', 'topK', 'topP', 'maxOutputTokens', 'mediaImage', 'mediaAudio', 'mediaVideo'].includes(param)) {
                    const numValue = (param.startsWith('media')) ? (value === 'true') : parseFloat(value);
                    if (!isNaN(numValue) || typeof numValue === 'boolean') {
                        await setConfig(chatId, param, numValue);
                        await msg.reply(`Parâmetro ${param} definido como ${numValue}`);
                    } else {
                        await msg.reply(`Valor inválido para ${param}. Use um número ou "true"/"false" se for mídia.`);
                    }
                } else {
                    await msg.reply(`Parâmetro desconhecido: ${param}`);
                }
            } else {
                await msg.reply('Uso correto: !config set <param> <valor>');
            }
            break;
        case 'get':
            const config = await getConfig(chatId);
            if (param) {
                if (config.hasOwnProperty(param)) {
                    await msg.reply(`${param}: ${config[param]}`);
                } else {
                    await msg.reply(`Parâmetro desconhecido: ${param}`);
                }
            } else {
                const configString = Object.entries(config)
                    .map(([key, value]) => `${key}: ${value}`)
                    .join('\n');
                await msg.reply(`Configuração atual:\n${configString}`);
            }
            break;
        default:
            await msg.reply('Subcomando de config desconhecido. Use !ajuda para ver os comandos disponíveis.');
    }
}

/**
 * Define um prompt de sistema
 * @param {string} chatId - ID do chat
 * @param {string} name - Nome do prompt
 * @param {string} text - Texto do prompt
 * @returns {Promise} Promise resolvida quando concluída
 */
function setSystemPrompt(chatId, name, text) {
    return new Promise((resolve, reject) => {
        const formattedText = `Seu nome é ${name}. ${text}`;
        promptsDb.update({ chatId, name }, { chatId, name, text: formattedText }, { upsert: true }, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

/**
 * Obtém um prompt de sistema pelo nome
 * @param {string} chatId - ID do chat
 * @param {string} name - Nome do prompt
 * @returns {Promise<Object>} Prompt encontrado ou null
 */
function getSystemPrompt(chatId, name) {
    return new Promise((resolve, reject) => {
        promptsDb.findOne({ chatId, name }, (err, doc) => {
            if (err) reject(err);
            else resolve(doc);
        });
    });
}

/**
 * Lista todos os prompts de sistema para um chat
 * @param {string} chatId - ID do chat
 * @returns {Promise<Array>} Lista de prompts
 */
function listSystemPrompts(chatId) {
    return new Promise((resolve, reject) => {
        promptsDb.find({ chatId }, (err, docs) => {
            if (err) reject(err);
            else resolve(docs);
        });
    });
}

/**
 * Define um prompt de sistema como ativo
 * @param {string} chatId - ID do chat
 * @param {string} promptName - Nome do prompt
 * @returns {Promise<boolean>} Verdadeiro se sucesso
 * @async
 */
async function setActiveSystemPrompt(chatId, promptName) {
    try {
        const prompt = await getSystemPrompt(chatId, promptName);
        if (prompt) {
            await setConfig(chatId, 'activePrompt', promptName);
            logger.debug(`Active prompt set for chat ${chatId}: ${promptName}`);
            return true;
        }
        return false;
    } catch (error) {
        logger.error(`Erro ao definir System Instruction ativa: ${error.message}`, { error });
        return false;
    }
}

/**
 * Remove o prompt de sistema ativo
 * @param {string} chatId - ID do chat
 * @returns {Promise<boolean>} Verdadeiro se sucesso
 * @async
 */
async function clearActiveSystemPrompt(chatId) {
    try {
        await setConfig(chatId, 'activePrompt', null);
        return true;
    } catch (error) {
        logger.error(`Erro ao limpar System Instruction ativa: ${error.message}`, { error });
        return false;
    }
}

/**
 * Define um parâmetro de configuração
 * @param {string} chatId - ID do chat
 * @param {string} param - Nome do parâmetro
 * @param {any} value - Valor do parâmetro
 * @returns {Promise} Promise resolvida quando concluída
 */
function setConfig(chatId, param, value) {
    return new Promise((resolve, reject) => {
        configDb.update(
            { chatId },
            { $set: { [param]: value } },
            { upsert: true },
            (err) => {
                if (err) reject(err);
                else resolve();
            }
        );
    });
}

/**
 * Obtém as configurações de um chat
 * @param {string} chatId - ID do chat
 * @returns {Promise<Object>} Configurações do chat
 * @async
 */
async function getConfig(chatId) {
    return new Promise((resolve, reject) => {
        configDb.findOne({ chatId }, async (err, doc) => {
            if (err) {
                reject(err);
            } else {
                const userConfig = doc || {};
                const config = { ...defaultConfig, ...userConfig };

                if (config.activePrompt) {
                    const activePrompt = await getSystemPrompt(chatId, config.activePrompt);
                    if (activePrompt) {
                        config.systemInstructions = activePrompt.text;
                        const match = config.systemInstructions.match(/^Seu nome é (\w+)\./);
                        config.botName = match ? match[1] : (process.env.BOT_NAME || 'Amélie');
                    }
                } else {
                    config.botName = process.env.BOT_NAME || 'Amélie';
                }

                if (config.systemInstructions && typeof config.systemInstructions !== 'string') {
                    config.systemInstructions = String(config.systemInstructions);
                }

                resolve(config);
            }
        });
    });
}

/**
 * Envia uma mensagem de resposta
 * @param {Object} msg - Mensagem original
 * @param {string} text - Texto da resposta
 * @async
 */
async function sendMessage(msg, text) {
    try {
        if (!text || typeof text !== 'string' || text.trim() === '') {
            logger.error('Tentativa de enviar mensagem inválida:', { text });
            text = "Desculpe, ocorreu um erro ao gerar a resposta. Por favor, tente novamente.";
        }

        let trimmedText = text.trim();
        trimmedText = trimmedText.replace(/^(?:amélie:[\s]*)+/i, '');
        trimmedText = trimmedText.replace(/^(?:amelie:[\s]*)+/i, '');
        trimmedText = trimmedText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n');

        // Obter informações do remetente e do chat
        const chat = await msg.getChat();
        const isGroup = chat.id._serialized.endsWith('@g.us');
        const sender = await getOrCreateUser(msg.author || msg.from);
        const senderName = sender.name;
        
        // Preparar o texto de log
        let logPrefix = `\nMensagem de ${senderName}`;
        
        // Adicionar informação do grupo, se aplicável
        if (isGroup) {
            const group = await getOrCreateGroup(chat);
            logPrefix += ` no grupo "${group.title || 'Desconhecido'}"`;
        }
        
        // Obter o corpo da mensagem original
        const originalMessage = msg.body || "[Mídia sem texto]";
        
        // Log no formato solicitado
        logger.info(`${logPrefix}: ${originalMessage}\nResposta: ${trimmedText}`);
        
        await msg.reply(trimmedText);
    } catch (error) {
        logger.error('Erro ao enviar mensagem:', { 
            error: error.message,
            stack: error.stack,
            text: text
        });
        await msg.reply(
            'Desculpe, ocorreu um erro ao enviar a resposta. Por favor, tente novamente.');
    }
}

// Configurar processador de vídeos integrado com timeouts
videoQueue.process('process-video', async (job) => {
    const { tempFilename, chatId, messageId, mimeType, userPrompt, senderNumber } = job.data;
    
    // Variável para armazenar o nome do arquivo no Google
    let googleFileName = null;
    
    try {
      logger.info(`Processando vídeo: ${tempFilename} (Job ${job.id})`);
      
      // Verificar se o arquivo existe
      if (!fs.existsSync(tempFilename)) {
        throw new Error("Arquivo temporário do vídeo não encontrado");
      }
      
      // Fazer upload para o Google AI com timeout
      const uploadPromise = fileManager.uploadFile(tempFilename, {
        mimeType: mimeType,
        displayName: "Vídeo Enviado"
      });
      
      const uploadTimeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error("Timeout no upload do vídeo")), 60000) // 1 minuto
      );
      
      const uploadResponse = await Promise.race([uploadPromise, uploadTimeoutPromise]);
      
      // Guardamos o nome do arquivo para poder excluí-lo depois
      googleFileName = uploadResponse.file.name;
  
      // Aguardar processamento com timeout total
      let file = await fileManager.getFile(googleFileName);
      let retries = 0;
      let totalProcessingTime = 0;
      const MAX_PROCESSING_TIME = 180000; // 3 minutos
      const RETRY_INTERVAL = 10000; // 10 segundos
      
      const startTime = Date.now();
      
      while (file.state === "PROCESSING" && retries < 12) {
        logger.info(`Vídeo ainda em processamento, aguardando... (tentativa ${retries + 1})`);
        await new Promise(resolve => setTimeout(resolve, RETRY_INTERVAL));
        
        totalProcessingTime = Date.now() - startTime;
        if (totalProcessingTime > MAX_PROCESSING_TIME) {
          throw new Error("Timeout total excedido no processamento do vídeo");
        }
        
        file = await fileManager.getFile(googleFileName);
        retries++;
      }
  
      if (file.state === "FAILED") {
        throw new Error("Falha no processamento do vídeo pelo Google AI");
      }
      
      if (file.state !== "SUCCEEDED" && file.state !== "ACTIVE") {
        throw new Error(`Estado inesperado do arquivo: ${file.state}`);
      }
  
      // Obter configurações do usuário
      const userConfig = await getConfig(chatId);
      
      // Obter modelo
      const model = getOrCreateModel({
        model: "gemini-2.0-flash",
        temperature: userConfig.temperature,
        topK: userConfig.topK,
        topP: userConfig.topP,
        maxOutputTokens: userConfig.maxOutputTokens,
        systemInstruction: userConfig.systemInstructions
      });
  
      // Preparar partes de conteúdo
      const contentParts = [
        {
          fileData: {
            mimeType: file.mimeType,
            fileUri: file.uri
          }
        },
        {
          text: (userConfig.systemInstructions || "") 
            + "\nFoque apenas neste vídeo. Descreva seu conteúdo de forma clara e detalhada.\n"
            + userPrompt
        }
      ];
  
      // Adicionar timeout para a chamada à IA
      const aiResponsePromise = model.generateContent(contentParts);
      const aiTimeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error("Timeout na análise de vídeo pela IA")), 60000) // 1 minuto
      );
      
      const result = await Promise.race([aiResponsePromise, aiTimeoutPromise]);
      let response = result.response.text();
      
      if (!response || typeof response !== 'string' || response.trim() === '') {
        response = "Não consegui gerar uma descrição clara para este vídeo.";
      }
      
      // Formatar resposta
      const finalResponse = `✅ *Análise do seu vídeo:*\n\n${response}\n\n_(Processado em ${Math.floor((Date.now() - job.processedOn) / 1000)}s)_`;
      
// Enviar resultado com timeout e fallback
if (isClientReady()) {
    const sendPromise = client.sendMessage(senderNumber, finalResponse);
    const sendTimeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error("Timeout ao enviar resposta")), 30000)
    );
    
    try {
        await Promise.race([sendPromise, sendTimeoutPromise]);
        logger.info(`Resposta de vídeo enviada com sucesso para ${senderNumber}`);
    } catch (sendError) {
        logger.error(`Erro ao enviar resposta do vídeo: ${sendError.message}`);
        
        // Salvar a notificação para ser processada pelo heartbeat
        await notificacoes.salvar(senderNumber, finalResponse);
    }
} else {
    logger.warn(`Cliente WhatsApp não está pronto, salvando notificação para ${senderNumber}`);
    await notificacoes.salvar(senderNumber, finalResponse);
}
      
      // Limpeza de arquivos (executada de qualquer forma)
      try {
        if (fs.existsSync(tempFilename)) {
          await fs.promises.unlink(tempFilename);
          logger.info(`Arquivo temporário ${tempFilename} removido após processamento bem-sucedido`);
        }
        
        if (googleFileName) {
          await fileManager.deleteFile(googleFileName);
          logger.info(`Arquivo removido do servidor Google: ${googleFileName}`);
        }
      } catch (cleanupError) {
        logger.warn(`Erro na limpeza de arquivos: ${cleanupError.message}`);
      }
      
      logger.info(`Vídeo processado com sucesso: ${job.id}`);
      
      return { success: true };
    } catch (error) {
      logger.error(`Erro ao processar vídeo na fila: ${error.message}`, { error, jobId: job.id });
      
// Notificar o usuário sobre o erro
try {
    const errorMessage = getErrorMessageForUser(error);
    
    if (isClientReady()) {
        const sendPromise = client.sendMessage(senderNumber, errorMessage);
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error("Timeout ao enviar mensagem de erro")), 10000)
        );
        
        await Promise.race([sendPromise, timeoutPromise]);
    } else {
        throw new Error("Cliente WhatsApp não está pronto");
    }
} catch (notifyError) {
    logger.error(`Não consegui notificar sobre o erro: ${notifyError.message}`);
    // Tentar salvar notificação
    try {
        await notificacoes.salvar(senderNumber, getErrorMessageForUser(error));
    } catch (notifErr) {
        logger.error(`Falha ao salvar notificação: ${notifErr.message}`);
    }
}
      
      // Limpeza de recursos
      try {
        if (fs.existsSync(tempFilename)) {
          fs.unlinkSync(tempFilename);
          logger.info(`Arquivo temporário ${tempFilename} removido após erro`);
        }
        
        if (googleFileName) {
          await fileManager.deleteFile(googleFileName);
          logger.info(`Arquivo do Google removido após erro: ${googleFileName}`);
        }
      } catch (cleanupError) {
        logger.warn(`Erro ao limpar recursos: ${cleanupError.message}`);
      }
      
      throw error; // Repropaga o erro para a fila lidar com ele
    }
  });
  
// Log de inicialização
logger.info('Sistema de processamento de vídeos em fila inicializado');

// Inicializa o cliente e configura tratamento de erros
client.initialize();

// Iniciar sistema de heartbeat para manter watchdog feliz
const heartbeat = new HeartbeatSystem(logger, client);
heartbeat.iniciar();

// Log de inicialização
logger.info('Sistema de processamento de vídeos em fila inicializado');

// Tratamento de erros não capturados
process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', { promise, reason });
});

process.on('uncaughtException', (error) => {
    logger.error(`Uncaught Exception: ${error.message}`, { error });
    process.exit(1);
});

// Exporta funções para uso em outros módulos
module.exports = {
    getOrCreateUser,
    updateMessageHistory,
    getMessageHistory,
    resetHistory,
    setSystemPrompt,
    getSystemPrompt,
    listSystemPrompts,
    setActiveSystemPrompt,
    clearActiveSystemPrompt,
    setConfig,
    getConfig,
    generateResponseWithText,
    handleTextMessage,
    handleImageMessage,
    handleAudioMessage,
};