import { CommanderError } from 'commander';
import { CliError, type CliIO } from './io.js';
import { explainMissingNativeDriver } from './native-driver.js';
import { createProgram } from './program.js';

/**
 * Run the CLI with user arguments (without `node` and the script path) and
 * return the process exit code. Never throws.
 */
export async function runCli(args: readonly string[], io: CliIO): Promise<number> {
  try {
    await createProgram(io).parseAsync([...args], { from: 'user' });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      // Commander already printed help, version or the usage error.
      return error.exitCode;
    }
    if (error instanceof CliError) {
      io.stderr(`error: ${error.message}\n`);
      return error.exitCode;
    }
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`error: ${explainMissingNativeDriver(message) ?? message}\n`);
    return 1;
  }
}
