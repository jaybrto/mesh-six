import type { Pool } from "pg";
import type { AgentRegistration, AgentScoreCard, TaskResult } from "./types.js";

const ROLLING_WINDOW = 20;
const RECENCY_DECAY = 0.95;
const HEALTH_CHECK_TIMEOUT = 3000;

export class AgentScorer {
  constructor(private pool: Pool) {}

  /**
   * Score agents for a given capability.
   * Returns agents sorted by final score (highest first).
   */
  async scoreAgents(
    agents: AgentRegistration[],
    capability: string
  ): Promise<AgentScoreCard[]> {
    const scores: AgentScoreCard[] = [];

    for (const agent of agents) {
      const cap = agent.capabilities.find((c) => c.name === capability);
      if (!cap) continue;

      // Check dependency health
      let dependencyHealth = 1;
      for (const req of cap.requirements) {
        const url = agent.healthChecks[req];
        if (url) {
          try {
            const res = await fetch(url, {
              signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT),
            });
            if (!res.ok) dependencyHealth = 0;
          } catch {
            dependencyHealth = 0;
          }
        }
      }

      // Rolling success rate with recency weighting
      const { rows: history } = await this.pool.query<{
        success: boolean;
        created_at: Date;
      }>(
        `SELECT success, created_at
         FROM agent_task_history
         WHERE agent_id = $1 AND capability = $2
         ORDER BY created_at DESC
         LIMIT $3`,
        [agent.appId, capability, ROLLING_WINDOW]
      );

      let rollingSuccessRate = 1.0; // default if no history
      let recencyBoost = 1.0;

      if (history.length > 0) {
        let weightedSuccess = 0;
        let totalWeight = 0;
        history.forEach((row, i) => {
          const weight = Math.pow(RECENCY_DECAY, i); // newer = higher weight
          weightedSuccess += row.success ? weight : 0;
          totalWeight += weight;
        });
        rollingSuccessRate = weightedSuccess / totalWeight;

        // Boost if last 3 tasks were all successful (agent recovered)
        const recent3 = history.slice(0, 3);
        if (recent3.length >= 3 && recent3.every((r) => r.success)) {
          recencyBoost = 1.1;
        }
      }

      const finalScore =
        cap.weight *
        dependencyHealth *
        rollingSuccessRate *
        recencyBoost *
        (cap.preferred ? 1.05 : 1.0); // slight preferred bonus

      scores.push({
        agentId: agent.appId,
        capability,
        baseWeight: cap.weight,
        dependencyHealth,
        rollingSuccessRate,
        recencyBoost,
        finalScore,
      });
    }

    return scores.sort((a, b) => b.finalScore - a.finalScore);
  }

  /**
   * Record a task result in the history table for future scoring.
   */
  async recordTaskResult(
    result: TaskResult,
    capability: string
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_task_history (
        id, agent_id, capability, success, duration_ms, error_type, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        result.taskId,
        result.agentId,
        capability,
        result.success,
        result.durationMs,
        result.error?.type ?? null,
        result.completedAt,
      ]
    );
  }

  /**
   * Get task history for an agent (for debugging/monitoring).
   */
  async getAgentHistory(
    agentId: string,
    limit: number = 20
  ): Promise<
    Array<{
      id: string;
      capability: string;
      success: boolean;
      durationMs: number;
      errorType: string | null;
      createdAt: Date;
    }>
  > {
    const { rows } = await this.pool.query<{
      id: string;
      capability: string;
      success: boolean;
      duration_ms: number;
      error_type: string | null;
      created_at: Date;
    }>(
      `SELECT id, capability, success, duration_ms, error_type, created_at
       FROM agent_task_history
       WHERE agent_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [agentId, limit]
    );

    return rows.map((r) => ({
      id: r.id,
      capability: r.capability,
      success: r.success,
      durationMs: r.duration_ms,
      errorType: r.error_type,
      createdAt: r.created_at,
    }));
  }
}
