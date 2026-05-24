/**
 * Scenario types for scripted cryptic exchanges.
 *
 * A scenario is a sequence of entries the agent terminal sends, each with an
 * optional expectation on the host's response. The runner executes them in
 * order over a live connection. Declarative, like pectab's scenarios.
 */

export interface ScenarioStep {
  /** A cryptic entry to send, or a control directive. */
  entry: string;
  /** Response must contain this substring for the step to pass. */
  expectContains?: string;
  /** Response must NOT contain this substring. */
  expectNotContains?: string;
  /** Free-text note printed before the step. */
  note?: string;
}

export interface Scenario {
  name: string;
  description: string;
  steps: ScenarioStep[];
}

export interface ScenarioResult {
  scenarioName: string;
  success: boolean;
  stepsCompleted: number;
  totalSteps: number;
  exchanges: Array<{ entry: string; response: string; ok: boolean }>;
  error?: string;
}
