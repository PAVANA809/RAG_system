# RAG System with Ollama, Qdrant & MCP

A complete Retrieval-Augmented Generation (RAG) system built with Node.js that lets you chat with your documents (PDF, DOCX, TXT) using a local LLM via Ollama.

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Chat UI    │────▶│RAG Agent    │────▶│   Ollama    │
│  (Browser)  │◀────│(Express)    │◀────│  (LLM/Emb)  │
└─────────────┘     └──────┬──────┘     └─────────────┘
                           │
                    ┌──────▼──────┐
                    │ MCP Client  │
                    └──────┬──────┘
                           │ stdio
                    ┌──────▼──────┐
                    │ MCP Server  │
                    │  (Qdrant)   │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │   Qdrant    │
                    │ (Vector DB) │
                    └─────────────┘
                           ▲
                           │
                    ┌──────┴──────┐
                    │ Doc Processor│
                    │  (Ingest)   │
                    └─────────────┘
```

## Components

1. **Document Processor** (`src/document-processor/index.js`) - Reads PDF, DOCX, TXT files from `./data`, chunks them, generates embeddings via Ollama, and stores vectors in Qdrant.

2. **MCP Server** (`src/mcp-server/server.js`) - Model Context Protocol server that exposes Qdrant operations as tools (search, upsert, create collection, list collections).

3. **RAG Agent** (`src/agent/index.js`) - Express API that receives user queries, generates query embeddings, searches Qdrant via MCP, builds a context-augmented prompt, and queries the LLM.

4. **Chat UI** (`src/chat-ui/public/`) - Clean, responsive web interface for asking questions and viewing answers with source attribution.

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Docker](https://docker.com/) & Docker Compose
- [Ollama](https://ollama.com/) running locally

## Setup

### 1. Clone / Navigate to Project

```bash
cd Rag_system
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` as needed:

```env
OLLAMA_BASE_URL=http://localhost:11434
EMBEDDING_MODEL=nomic-embed-text
LLM_MODEL=qwen2.5-coder:7b
QDRANT_URL=http://localhost:6333
QDRANT_COLLECTION=documents
DATA_DIR=./data
CHUNK_SIZE=1000
CHUNK_OVERLAP=200
PORT=3000
```

### 4. Pull Required Ollama Models

```bash
# Chat model
ollama pull qwen2.5-coder:7b

# Embedding model (required for vector generation)
ollama pull nomic-embed-text
```

> **Note:** `nomic-embed-text` is used for embeddings because it produces high-quality 768-dimensional vectors. `qwen2.5-coder:7b` handles the chat/QA responses.

### 5. Start Qdrant (Docker)

```bash
docker-compose up -d
```

Qdrant will be available at:
- REST API: http://localhost:6333
- Dashboard: http://localhost:6333/dashboard

### 6. Add Your Documents

Place `.pdf`, `.docx`, or `.txt` files into the `data/` folder.

### 7. Ingest Documents

```bash
npm run ingest
```

This will:
- Extract text from all supported files
- Split text into overlapping chunks
- Generate embeddings via Ollama
- Store vectors + metadata in Qdrant

### 8. Start the RAG Application

```bash
npm start
```

Open http://localhost:3000 in your browser and start chatting with your documents!

## Scripts

| Script | Description |
|--------|-------------|
| `npm start` | Start the RAG agent + chat UI server |
| `npm run ingest` | Process documents and index into Qdrant |
| `npm run mcp-server` | Run the MCP server standalone (stdio) |

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/chat` | Send a question, get RAG response |
| GET | `/api/health` | Check system health and configuration |

### Example API Call

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "What are the key points in my document?"}'
```

## MCP Tools

The MCP server exposes these tools for Qdrant interaction:

| Tool | Description |
|------|-------------|
| `search_points` | Vector similarity search in a collection |
| `upsert_points` | Insert or update points |
| `create_collection` | Create a new vector collection |
| `list_collections` | List all collections |
| `get_collection_info` | Get collection metadata |

## File Structure

```
Rag_system/
├── docker-compose.yml              # Qdrant container config
├── package.json
├── .env                            # Your environment config
├── .env.example                    # Template
├── data/                           # Drop your documents here
│   └── .gitkeep
├── src/
│   ├── document-processor/
│   │   └── index.js                # Component 1: Ingest & vectorize
│   ├── mcp-server/
│   │   └── server.js               # Component 2: MCP server for Qdrant
│   ├── agent/
│   │   └── index.js                # Component 3: RAG agent + API
│   └── chat-ui/
│       └── public/
│           ├── index.html          # Component 4: Chat UI
│           ├── style.css
│           └── app.js
```

## Troubleshooting

### Qdrant connection refused
- Ensure Docker is running: `docker-compose up -d`
- Check port 6333 is not in use: `lsof -i :6333` (macOS/Linux) or `netstat -ano | findstr 6333` (Windows)

### Ollama connection errors
- Verify Ollama is running: `ollama list`
- Ensure models are pulled: `ollama pull nomic-embed-text` and `ollama pull qwen2.5-coder:7b`

### Out of memory / "model requires more system memory"
Your system doesn't have enough RAM for the selected model. Switch to a smaller model:
```bash
# Low RAM options (~1-2 GB)
ollama pull qwen2.5-coder:1.5b
ollama pull llama3.2:1b

# Then update .env
LLM_MODEL=qwen2.5-coder:1.5b
```

### No documents found
- Place files in the `data/` directory
- Supported formats: `.txt`, `.pdf`, `.docx`

### Embedding model issues
If you prefer a different embedding model, update `EMBEDDING_MODEL` in `.env`. Make sure to re-run `npm run ingest` after changing models (vector dimensions must match the collection).

### Collection already exists with different vector size
Delete the Qdrant volume and restart:
```bash
docker-compose down -v
docker-compose up -d
npm run ingest
```

### Re-ingesting documents
Running `npm run ingest` again is safe:
- **Same files, same settings**: Points are overwritten (IDs are deterministic)
- **Edited files**: New chunks overwrite old ones, but stale chunks may remain
- **To do a clean full re-ingest**: Set `CLEAR_BEFORE_INGEST=true` in `.env`, then run `npm run ingest`

## Tech Stack

- **Runtime**: Node.js 18+ (ES Modules)
- **Vector DB**: Qdrant (via Docker)
- **LLM**: Ollama (local inference)
- **Embeddings**: Ollama + nomic-embed-text
- **MCP**: Model Context Protocol SDK
- **Web**: Express.js + vanilla JS frontend
- **PDF Parsing**: pdf-parse
- **DOCX Parsing**: mammoth

## Sample Questions to Try

After running `npm run ingest` and `npm start`, try asking these questions in the chat UI at http://localhost:3000:

### OSI Model
- What are the seven layers of the OSI model and what does each layer do?
- Which OSI layer handles routing and IP addressing?
- What is the difference between TCP and UDP in terms of the OSI model?
- At which layer do MAC addresses operate?

### TCP/IP Protocols
- Explain the three-way handshake in TCP.
- What is the difference between TCP and UDP?
- How does DNS work and which port does it use?
- What is BGP and why is it important for the internet?

### 5G Technology
- What are the three frequency bands used in 5G?
- What is network slicing and how does it work?
- What is Massive MIMO and how does it improve 5G performance?
- Compare the latency of 5G versus 4G LTE.

### Fiber Optics
- What is the difference between single-mode and multimode fiber?
- What is total internal reflection and why is it important in fiber optics?
- How does Wavelength Division Multiplexing work?
- What are EDFAs and why are they important?

### Network Security
- What is the CIA Triad in network security?
- Explain the difference between IDS and IPS.
- What is Zero Trust architecture?
- How do VPNs work and what are the two main types?

## License

MIT
