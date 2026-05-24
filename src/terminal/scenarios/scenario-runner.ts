/**
 * Scenario runner — executes a Scenario against a connected AgentTerminal.
 */

import type { AgentTerminal } from '../agent-terminal.js';
import type { Scenario, ScenarioResult, ScenarioStep } from './scenario.js';
import { Logger } from '../../logging/logger.js';

export class ScenarioRunner {
  private logger = new Logger('SCEN', 'info');

  constructor(private readonly terminal: AgentTerminal) {}

  async run(scenario: Scenario): Promise<ScenarioResult> {
    this.logger.section(scenario.name);
    const result: ScenarioResult = {
      scenarioName: scenario.name,
      success: true,
      stepsCompleted: 0,
      totalSteps: scenario.steps.length,
      exchanges: [],
    };

    for (const step of scenario.steps) {
      if (step.note) this.logger.info(step.note);
      try {
        const response = await this.terminal.enter(step.entry);
        const ok = this.check(step, response);
        result.exchanges.push({ entry: step.entry, response, ok });
        if (!ok) {
          result.success = false;
          result.error = `Step "${step.entry}" failed expectation`;
          break;
        }
        result.stepsCompleted++;
      } catch (err) {
        result.success = false;
        result.error = `Step "${step.entry}" threw: ${(err as Error).message}`;
        break;
      }
    }

    return result;
  }

  private check(step: ScenarioStep, response: string): boolean {
    if (step.expectContains && !response.includes(step.expectContains)) return false;
    if (step.expectNotContains && response.includes(step.expectNotContains)) return false;
    return true;
  }
}
