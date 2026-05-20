const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const { Anthropic } = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

// Inicializar cliente Claude
const client = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY
});

const configPath = path.join(__dirname, 'config.json');
const dbPath = path.join(__dirname, 'database.json');

// ===== BANCO DE DADOS =====

function carregarConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    console.error('❌ Erro ao carregar config.json:', e.message);
    return { imoveis: [], perguntasFrequentes: {} };
  }
}

function carregarDB() {
  try {
    if (fs.existsSync(dbPath)) {
      return JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    }
  } catch (e) {
    console.error('❌ Erro ao carregar database.json:', e.message);
  }
  return { conversas: {}, agendamentos: [] };
}

function salvarDB(db) {
  try {
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error('❌ Erro ao salvar database.json:', e.message);
  }
}

// ===== PROMPT DA IA =====

function criarPrompt(mensagemCliente, config, historicoConversa) {
  const imoveis = config.imoveis || [];

  const imoveisTexto = imoveis.map(i => `
--- ${i.nome} ---
Preço: ${i.preco}
Localização: ${i.localizacao}
Quartos: ${i.quartos} | Banheiros: ${i.banheiros} | Área: ${i.area}
Descrição: ${i.descricao}
Disponível: ${i.disponivel ? 'Sim' : 'Não'}
`).join('\n');

  const faqTexto = Object.entries(config.perguntasFrequentes || {})
    .map(([k, v]) => `• ${k.replace(/_/g, ' ')}: ${v}`)
    .join('\n');

  return `Você é um agente de aluguel de imóveis profissional e simpático chamado "Assistente Elito Kitnet".

=== IMÓVEIS DISPONÍVEIS ===
${imoveisTexto}

=== PERGUNTAS FREQUENTES ===
${faqTexto}

=== SEU OBJETIVO ===
1. Responder dúvidas sobre os imóveis com precisão
2. Fazer pré-entrevista para entender o perfil do cliente:
   - Qual é seu orçamento?
   - Quantos quartos precisa?
   - Quando quer se mudar?
   - Tem animais de estimação?
3. Sugerir o imóvel mais adequado para o cliente
4. Quando perceber interesse real, oferecer para agendar uma visita

=== REGRAS ===
- Responda SEMPRE em português
- Seja amigável e profissional
- Respostas curtas (máximo 3-4 linhas)
- Use emojis com moderação
- Não invente informações que não estão acima
- Se não souber algo, diga que vai verificar

=== HISTÓRICO DA CONVERSA ===
${historicoConversa || '(Início da conversa)'}

=== MENSAGEM DO CLIENTE ===
"${mensagemCliente}"

Responda naturalmente:`;
}

// ===== ENVIAR MENSAGEM VIA EVOLUTION API =====

async function enviarMensagem(numeroDestino, texto) {
  try {
    const url = `${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`;

    await axios.post(url, {
      number: numeroDestino,
      text: texto
    }, {
      headers: {
        'apikey': process.env.EVOLUTION_API_KEY,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });

    console.log(`✅ Mensagem enviada para ${numeroDestino}`);
  } catch (error) {
    console.error('❌ Erro ao enviar mensagem:', error.response?.data || error.message);
  }
}

// ===== WEBHOOK - RECEBER MENSAGENS =====

app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    // Verificar se é uma mensagem recebida
    const evento = body.event;
    if (evento !== 'messages.upsert') {
      return res.sendStatus(200);
    }

    const mensagem = body.data;

    // Ignorar mensagens enviadas pelo próprio agente
    if (mensagem?.key?.fromMe) {
      return res.sendStatus(200);
    }

    // Extrair dados da mensagem
    const from = mensagem?.key?.remoteJid;
    const texto = mensagem?.message?.conversation ||
                  mensagem?.message?.extendedTextMessage?.text || '';

    if (!from || !texto) {
      return res.sendStatus(200);
    }

    // Limpar número (remover @s.whatsapp.net)
    const numero = from.replace('@s.whatsapp.net', '');

    console.log(`📱 Mensagem de ${numero}: "${texto.substring(0, 60)}..."`);

    // Carregar dados
    const config = carregarConfig();
    const db = carregarDB();

    // Montar histórico (últimas 10 mensagens)
    let historico = '';
    if (db.conversas[numero] && db.conversas[numero].length > 0) {
      historico = db.conversas[numero]
        .slice(-10)
        .map(m => `${m.tipo === 'cliente' ? 'Cliente' : 'Agente'}: ${m.texto}`)
        .join('\n');
    }

    // Gerar resposta com Claude
    console.log('🤖 Processando com Claude...');
    const prompt = criarPrompt(texto, config, historico);

    const response = await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }]
    });

    const resposta = response.content[0].type === 'text'
      ? response.content[0].text
      : 'Desculpe, tive um problema. Pode repetir?';

    // Salvar conversa
    if (!db.conversas[numero]) db.conversas[numero] = [];
    db.conversas[numero].push({ tipo: 'cliente', texto, timestamp: new Date().toISOString() });
    db.conversas[numero].push({ tipo: 'agente', texto: resposta, timestamp: new Date().toISOString() });
    salvarDB(db);

    // Enviar resposta
    await enviarMensagem(from, resposta);

    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Erro no webhook:', error.message);
    res.sendStatus(500);
  }
});

// ===== HEALTH CHECK =====

app.get('/health', (req, res) => {
  const config = carregarConfig();
  const db = carregarDB();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    imoveis: config.imoveis?.length || 0,
    conversas: Object.keys(db.conversas || {}).length
  });
});

app.get('/', (req, res) => {
  res.json({ nome: 'Agente WhatsApp - Elito Kitnet', status: 'ativo', versao: '2.0' });
});

// ===== INICIAR SERVIDOR =====

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║   🚀 AGENTE WHATSAPP - ELITO KITNET  ║');
  console.log(`║   ✅ Rodando na porta ${PORT}           ║`);
  console.log('╚══════════════════════════════════════╝\n');
  console.log(`📍 Webhook: http://localhost:${PORT}/webhook`);
  console.log(`❤️  Health: http://localhost:${PORT}/health\n`);
});
