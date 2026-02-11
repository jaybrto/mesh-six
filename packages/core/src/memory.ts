import { Memory } from "mem0ai/oss";

export interface MemoryConfig {
  // PostgreSQL connection for pgvector
  pgHost: string;
  pgPort: number;
  pgUser: string;
  pgPassword: string;
  pgDatabase: string;

  // Ollama for embeddings
  ollamaUrl: string;
  ollamaEmbedModel: string;

  // LLM for memory extraction (Ollama)
  ollamaLlmModel: string;

  // Collection name prefix
  collectionPrefix?: string;
}

export interface MemoryMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface MemorySearchResult {
  id: string;
  memory: string;
  score: number;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * AgentMemory - Wrapper around mem0ai for agent memory management.
 *
 * Uses pgvector for vector storage and Ollama for embeddings/LLM.
 * Each agent has its own collection namespace.
 */
export class AgentMemory {
  private memory: Memory;
  private agentId: string;

  constructor(agentId: string, config: MemoryConfig) {
    this.agentId = agentId;

    const collectionName = config.collectionPrefix
      ? `${config.collectionPrefix}_${agentId}`
      : `memories_${agentId}`;

    // Build config - mem0ai types may be incomplete for Ollama url property
    const vectorStoreConfig: Record<string, unknown> = {
      collectionName,
      embeddingModelDims: 768,
      host: config.pgHost,
      port: config.pgPort,
      user: config.pgUser,
      password: config.pgPassword,
      dbname: config.pgDatabase,
    };

    const embedderConfig: Record<string, unknown> = {
      model: config.ollamaEmbedModel,
      url: config.ollamaUrl,
    };

    const llmConfig: Record<string, unknown> = {
      model: config.ollamaLlmModel,
      url: config.ollamaUrl,
      temperature: 0.1,
    };

    this.memory = new Memory({
      version: "v1.1",
      vectorStore: {
        provider: "pgvector",
        config: vectorStoreConfig,
      },
      embedder: {
        provider: "ollama",
        config: embedderConfig,
      },
      llm: {
        provider: "ollama",
        config: llmConfig,
      },
    } as any);
  }

  /**
   * Store a conversation in memory.
   * Mem0 automatically extracts key information and stores it.
   */
  async store(
    messages: MemoryMessage[],
    userId: string = "default",
    metadata?: Record<string, unknown>
  ): Promise<void> {
    try {
      await this.memory.add(messages, {
        userId,
        agentId: this.agentId,
        metadata: {
          ...metadata,
          storedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      console.error(`[Memory:${this.agentId}] Failed to store:`, error);
      throw error;
    }
  }

  /**
   * Search for relevant memories based on a query.
   */
  async search(
    query: string,
    userId: string = "default",
    limit: number = 5
  ): Promise<MemorySearchResult[]> {
    try {
      const results = await this.memory.search(query, {
        userId,
        agentId: this.agentId,
        limit,
      });

      return (results.results || []).map((r: any) => ({
        id: r.id,
        memory: r.memory,
        score: r.score || 0,
        metadata: r.metadata,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
    } catch (error) {
      console.error(`[Memory:${this.agentId}] Failed to search:`, error);
      return [];
    }
  }

  /**
   * Get all memories for a user.
   */
  async getAll(userId: string = "default"): Promise<MemorySearchResult[]> {
    try {
      const results = await this.memory.getAll({
        userId,
        agentId: this.agentId,
      });

      return (results.results || []).map((r: any) => ({
        id: r.id,
        memory: r.memory,
        score: 1,
        metadata: r.metadata,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
    } catch (error) {
      console.error(`[Memory:${this.agentId}] Failed to get all:`, error);
      return [];
    }
  }

  /**
   * Delete a specific memory by ID.
   */
  async delete(memoryId: string): Promise<void> {
    try {
      await this.memory.delete(memoryId);
    } catch (error) {
      console.error(`[Memory:${this.agentId}] Failed to delete:`, error);
      throw error;
    }
  }

  /**
   * Delete all memories for a user.
   */
  async deleteAll(userId: string = "default"): Promise<void> {
    try {
      await this.memory.deleteAll({
        userId,
        agentId: this.agentId,
      });
    } catch (error) {
      console.error(`[Memory:${this.agentId}] Failed to delete all:`, error);
      throw error;
    }
  }

  /**
   * Get memory history (changes over time) for a specific memory.
   */
  async history(memoryId: string): Promise<any[]> {
    try {
      const result = await this.memory.history(memoryId);
      return result || [];
    } catch (error) {
      console.error(`[Memory:${this.agentId}] Failed to get history:`, error);
      return [];
    }
  }
}

/**
 * Create AgentMemory from environment variables.
 */
export function createAgentMemoryFromEnv(agentId: string): AgentMemory {
  const config: MemoryConfig = {
    pgHost: process.env.PG_PRIMARY_HOST || "localhost",
    pgPort: Number(process.env.PG_PRIMARY_PORT) || 5432,
    pgUser: process.env.PG_PRIMARY_USER || "admin",
    pgPassword: process.env.PG_PRIMARY_PASSWORD || "",
    pgDatabase: process.env.PG_PRIMARY_DB || "mesh_six",
    ollamaUrl: process.env.OLLAMA_URL || "http://localhost:11434",
    ollamaEmbedModel: process.env.OLLAMA_MODEL_EMBED || "mxbai-embed",
    ollamaLlmModel: process.env.OLLAMA_MODEL || "phi4-mini",
    collectionPrefix: "mesh_six",
  };

  return new AgentMemory(agentId, config);
}
