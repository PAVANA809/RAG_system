#!/usr/bin/env node
import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { QdrantClient } from '@qdrant/js-client-rest';

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const qdrant = new QdrantClient({ url: QDRANT_URL });

const server = new Server(
  { name: 'qdrant-mcp-server', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'search_points',
        description: 'Search for similar vectors in a Qdrant collection',
        inputSchema: {
          type: 'object',
          properties: {
            collection: {
              type: 'string',
              description: 'Name of the Qdrant collection to search',
            },
            vector: {
              type: 'array',
              items: { type: 'number' },
              description: 'Query embedding vector',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results to return',
              default: 5,
            },
          },
          required: ['collection', 'vector'],
        },
      },
      {
        name: 'upsert_points',
        description: 'Upsert (insert or update) points into a Qdrant collection',
        inputSchema: {
          type: 'object',
          properties: {
            collection: {
              type: 'string',
              description: 'Name of the Qdrant collection',
            },
            points: {
              type: 'array',
              description: 'Array of points to upsert',
              items: {
                type: 'object',
                properties: {
                  id: {
                    type: 'string',
                    description: 'Unique point identifier',
                  },
                  vector: {
                    type: 'array',
                    items: { type: 'number' },
                    description: 'Embedding vector',
                  },
                  payload: {
                    type: 'object',
                    description: 'Optional metadata payload',
                  },
                },
                required: ['id', 'vector'],
              },
            },
          },
          required: ['collection', 'points'],
        },
      },
      {
        name: 'create_collection',
        description: 'Create a new Qdrant collection with specified vector configuration',
        inputSchema: {
          type: 'object',
          properties: {
            collection: {
              type: 'string',
              description: 'Name for the new collection',
            },
            vectorSize: {
              type: 'number',
              description: 'Dimensionality of vectors',
              default: 768,
            },
            distance: {
              type: 'string',
              description: 'Distance metric: Cosine, Euclid, or Dot',
              default: 'Cosine',
            },
          },
          required: ['collection'],
        },
      },
      {
        name: 'list_collections',
        description: 'List all available Qdrant collections',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_collection_info',
        description: 'Get information about a specific Qdrant collection',
        inputSchema: {
          type: 'object',
          properties: {
            collection: {
              type: 'string',
              description: 'Name of the collection',
            },
          },
          required: ['collection'],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'search_points') {
      const result = await qdrant.search(args.collection, {
        vector: args.vector,
        limit: args.limit || 5,
        with_payload: true,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }

    if (name === 'upsert_points') {
      await qdrant.upsert(args.collection, {
        wait: true,
        points: args.points,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, upserted: args.points.length }) }],
      };
    }

    if (name === 'create_collection') {
      await qdrant.createCollection(args.collection, {
        vectors: {
          size: args.vectorSize || 768,
          distance: args.distance || 'Cosine',
        },
      });
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, collection: args.collection }) }],
      };
    }

    if (name === 'list_collections') {
      const result = await qdrant.getCollections();
      return {
        content: [{ type: 'text', text: JSON.stringify(result.collections.map((c) => c.name)) }],
      };
    }

    if (name === 'get_collection_info') {
      const result = await qdrant.getCollection(args.collection);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: error.message }) }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Qdrant MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error in MCP server:', error);
  process.exit(1);
});
