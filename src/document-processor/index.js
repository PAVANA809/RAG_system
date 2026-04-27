import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { Ollama } from 'ollama';
import { QdrantClient } from '@qdrant/js-client-rest';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'nomic-embed-text';
const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const QDRANT_COLLECTION = process.env.QDRANT_COLLECTION || 'documents';
const DATA_DIR = process.env.DATA_DIR || './data';
const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || '1000');
const CHUNK_OVERLAP = parseInt(process.env.CHUNK_OVERLAP || '200');
const CLEAR_BEFORE_INGEST = process.env.CLEAR_BEFORE_INGEST === 'true';

const ollama = new Ollama({ host: OLLAMA_BASE_URL });
const qdrant = new QdrantClient({ url: QDRANT_URL });

function generatePointId(fileName, chunkIndex) {
  // Create a deterministic integer ID from filename + chunk index
  // Using SHA-256 hash then taking a portion to create a unique integer
  const hashInput = `${fileName}#chunk#${chunkIndex}`;
  const hashHex = crypto.createHash('sha256').update(hashInput).digest('hex');
  // Use first 14 hex chars (56 bits) to stay well within safe integer range
  const intValue = parseInt(hashHex.substring(0, 14), 16);
  return intValue;
}

function chunkText(text, size, overlap) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + size));
    i += size - overlap;
  }
  return chunks;
}

async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const buffer = await fs.readFile(filePath);

  if (ext === '.txt') {
    return buffer.toString('utf-8');
  }

  if (ext === '.pdf') {
    const data = await pdfParse(buffer);
    return data.text;
  }

  if (ext === '.docx') {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  console.warn(`  ⚠️ Unsupported file type: ${ext}`);
  return null;
}

async function ensureCollection() {
  try {
    const collections = await qdrant.getCollections();
    const exists = collections.collections.some((c) => c.name === QDRANT_COLLECTION);

    if (!exists) {
      const testEmbed = await ollama.embeddings({
        model: EMBEDDING_MODEL,
        prompt: 'test',
      });
      const vectorSize = testEmbed.embedding.length;

      await qdrant.createCollection(QDRANT_COLLECTION, {
        vectors: {
          size: vectorSize,
          distance: 'Cosine',
        },
      });
      console.log(`✅ Created collection: ${QDRANT_COLLECTION} with vector size ${vectorSize}`);
    } else {
      console.log(`✅ Collection ${QDRANT_COLLECTION} already exists`);
    }
  } catch (error) {
    console.error('❌ Error ensuring collection:', error.message);
    throw error;
  }
}

async function processDocuments() {
  console.log('\n📄 Document Processor Starting...\n');

  await ensureCollection();

  let files;
  try {
    files = await fs.readdir(DATA_DIR);
  } catch (error) {
    console.error(`❌ Cannot read data directory: ${DATA_DIR}`);
    console.error(error.message);
    process.exit(1);
  }

  const supportedExts = ['.txt', '.pdf', '.docx'];
  const targetFiles = files.filter((f) => supportedExts.includes(path.extname(f).toLowerCase()));

  if (targetFiles.length === 0) {
    console.log('⚠️ No supported documents found in', DATA_DIR);
    console.log('Supported formats: .txt, .pdf, .docx');
    return;
  }

  console.log(`📁 Found ${targetFiles.length} document(s) to process\n`);

  if (CLEAR_BEFORE_INGEST) {
    try {
      console.log('🧹 CLEAR_BEFORE_INGEST=true - deleting all existing points...');
      await qdrant.delete(QDRANT_COLLECTION, {
        wait: true,
        filter: {}, // empty filter = match all
      });
      console.log('✅ Cleared all existing points\n');
    } catch (error) {
      console.error('❌ Failed to clear collection:', error.message);
    }
  }

  for (const file of targetFiles) {
    const filePath = path.join(DATA_DIR, file);
    console.log(`🔄 Processing: ${file}`);

    const text = await extractText(filePath);
    if (!text || text.trim().length === 0) {
      console.log(`  ⚠️ No text extracted from ${file}`);
      continue;
    }

    const chunks = chunkText(text, CHUNK_SIZE, CHUNK_OVERLAP);
    console.log(`  ✂️ Split into ${chunks.length} chunk(s)`);

    const points = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      try {
        const embedResult = await ollama.embeddings({
          model: EMBEDDING_MODEL,
          prompt: chunk,
        });

        points.push({
          id: generatePointId(file, i),
          vector: embedResult.embedding,
          payload: {
            text: chunk,
            source: file,
            chunk_index: i,
          },
        });
      } catch (error) {
        console.error(`  ❌ Error embedding chunk ${i} of ${file}:`, error.message);
      }
    }

    if (points.length > 0) {
      try {
        await qdrant.upsert(QDRANT_COLLECTION, {
          wait: true,
          points,
        });
        console.log(`  ✅ Upserted ${points.length} point(s) to Qdrant\n`);
      } catch (error) {
        console.error(`  ❌ Error upserting points for ${file}:`, error.message);
        if (error.status !== undefined) console.error(`     Status: ${error.status}`);
        if (error.statusText !== undefined) console.error(`     Status Text: ${error.statusText}`);
        if (typeof error.data === 'string') {
          try {
            const parsed = JSON.parse(error.data);
            console.error(`     Response:`, JSON.stringify(parsed, null, 2));
          } catch {
            console.error(`     Response:`, error.data);
          }
        }
      }
    }
  }

  console.log('🎉 Document processing complete!\n');
}

processDocuments().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
