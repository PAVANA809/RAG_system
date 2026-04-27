import 'dotenv/config';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Ollama } from 'ollama';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'nomic-embed-text';
const LLM_MODEL = process.env.LLM_MODEL || 'qwen2.5-coder:7b';
const QDRANT_COLLECTION = process.env.QDRANT_COLLECTION || 'documents';
const SEARCH_LIMIT = parseInt(process.env.SEARCH_LIMIT || '10');
const PORT = process.env.PORT || 3000;

const ollama = new Ollama({ host: OLLAMA_BASE_URL });

// In-memory conversation history per session
const conversations = new Map();
const MAX_HISTORY_MESSAGES = 20;

async function initializeMcpClient() {
  const client = new Client({ name: 'rag-agent', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: 'node',
    args: [path.join(__dirname, '..', 'mcp-server', 'server.js')],
    env: {
      ...process.env,
      QDRANT_URL: process.env.QDRANT_URL || 'http://localhost:6333',
    },
  });

  await client.connect(transport);
  console.log('✅ MCP Client connected to Qdrant MCP Server');
  return client;
}

async function buildSystemPrompt(contexts) {
  const contextText = contexts
    .map((c, i) => `[${i + 1}] Source: ${c.source}\n${c.text}`)
    .join('\n\n');

  return `You are a helpful assistant that answers questions based on the provided documents.
Use the following context to answer the user's question. If the context doesn't contain enough information to answer, say so clearly. Be concise, accurate, and cite the source numbers when referencing information.

Context:
${contextText}

Answer the user's question based ONLY on the context above. If the answer is not in the context, say "I don't have enough information to answer that question."`;
}

app.post('/api/chat', async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message is required and must be a string' });
    }

    const sessionKey = sessionId || 'default';
    if (!conversations.has(sessionKey)) {
      conversations.set(sessionKey, []);
    }
    const history = conversations.get(sessionKey);

    console.log(`\n📝 [${sessionKey}] User Query: ${message} (history: ${history.length} msgs)`);

    let mcpClient;
    try {
      mcpClient = await initializeMcpClient();
    } catch (error) {
      console.error('❌ Failed to connect to MCP server:', error.message);
      return res.status(500).json({ error: 'Failed to connect to vector database service' });
    }

    let vector;
    try {
      const embedResponse = await ollama.embeddings({
        model: EMBEDDING_MODEL,
        prompt: message,
      });
      vector = embedResponse.embedding;
      console.log('✅ Query embedding generated');
    } catch (error) {
      console.error('❌ Failed to generate embedding:', error.message);
      return res.status(500).json({ error: 'Failed to process query embedding' });
    }

    let contexts = [];
    try {
      const searchResult = await mcpClient.callTool({
        name: 'search_points',
        arguments: {
          collection: QDRANT_COLLECTION,
          vector,
          limit: SEARCH_LIMIT,
        },
      });

      const searchText = searchResult.content[0].text;
      const searchData = JSON.parse(searchText);

      if (searchData.error) {
        console.error('❌ Qdrant search error:', searchData.error);
        if (searchData.error.includes('Not found')) {
          return res.status(404).json({
            error: 'No document collection found. Please run "npm run ingest" first to index your documents.',
          });
        }
        throw new Error(searchData.error);
      }

      contexts = searchData.map((point) => ({
        text: point.payload?.text || '',
        source: point.payload?.source || 'unknown',
        score: point.score,
      }));

      // Log retrieved sources for debugging
      const uniqueSources = [...new Set(contexts.map((c) => c.source))];
      console.log(`✅ Found ${contexts.length} chunk(s) from ${uniqueSources.length} source(s): ${uniqueSources.join(', ')}`);
    } catch (error) {
      console.error('❌ Search error:', error.message);
      return res.status(500).json({ error: 'Failed to search vector database' });
    }

    let response;
    try {
      const systemPrompt = await buildSystemPrompt(contexts);

      // Build messages: system prompt + conversation history + current user message
      const messages = [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: message },
      ];

      const chatResponse = await ollama.chat({
        model: LLM_MODEL,
        messages,
        stream: false,
      });

      response = chatResponse.message.content;
      console.log('✅ LLM response generated\n');

      // Store this turn in history
      history.push({ role: 'user', content: message });
      history.push({ role: 'assistant', content: response });

      // Trim history to prevent token overflow
      if (history.length > MAX_HISTORY_MESSAGES) {
        history.splice(0, history.length - MAX_HISTORY_MESSAGES);
      }
    } catch (error) {
      console.error('❌ LLM error:', error.message);
      const isMemoryError = error.message && error.message.includes('system memory');
      if (isMemoryError) {
        return res.status(507).json({
          error: `Your system doesn't have enough RAM to run ${LLM_MODEL}. ` +
                 `Try a smaller model like qwen2.5-coder:1.5b or llama3.2:1b. ` +
                 `Update LLM_MODEL in your .env file and restart.`,
        });
      }
      return res.status(500).json({ error: 'Failed to generate response from language model' });
    }

    res.json({
      response,
      sources: contexts.map((c) => ({
        source: c.source,
        score: c.score,
      })),
    });
  } catch (error) {
    console.error('❌ Unexpected error:', error);
    res.status(500).json({ error: 'An unexpected error occurred' });
  }
});

app.post('/api/clear', (req, res) => {
  const { sessionId } = req.body;
  const sessionKey = sessionId || 'default';
  if (conversations.has(sessionKey)) {
    conversations.delete(sessionKey);
    console.log(`🗑️ Cleared conversation history for session: ${sessionKey}`);
  }
  res.json({ success: true });
});

app.get('/api/health', async (req, res) => {
  try {
    const mcpClient = await initializeMcpClient();
    const collectionsResult = await mcpClient.callTool({
      name: 'list_collections',
      arguments: {},
    });
    const collections = JSON.parse(collectionsResult.content[0].text);

    res.json({
      status: 'ok',
      ollama: OLLAMA_BASE_URL,
      qdrant: process.env.QDRANT_URL || 'http://localhost:6333',
      model: LLM_MODEL,
      embeddingModel: EMBEDDING_MODEL,
      collections,
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.use(express.static(path.join(__dirname, '..', 'chat-ui', 'public')));

app.listen(PORT, () => {
  console.log('\n🚀 RAG System Started\n');
  console.log(`🌐 Chat UI: http://localhost:${PORT}`);
  console.log(`🤖 LLM Model: ${LLM_MODEL}`);
  console.log(`🔤 Embedding Model: ${EMBEDDING_MODEL}`);
  console.log(`📊 Qdrant Collection: ${QDRANT_COLLECTION}`);
  console.log(`\n📁 Place documents in ./data and run: npm run ingest\n`);
});
