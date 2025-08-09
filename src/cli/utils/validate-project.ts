
import { readFile } from "fs/promises";
import { findUp } from 'find-up';
import { logger } from "../../core/Logger.js";


export async function validateMCPProject() {
  try {
    const packageJsonPath = await findUp('package.json');
    
    if (!packageJsonPath) {
      throw new Error("Could not find package.json in current directory or any parent directories");
    }
    const package_json = JSON.parse(await readFile(packageJsonPath, "utf-8"));
    const allDeps = [
      ...(package_json.dependencies ? Object.keys(package_json.dependencies) : []),
      ...(package_json.devDependencies ? Object.keys(package_json.devDependencies) : [])
    ];
    if (
      !allDeps.some(dep => dep === 'mcp-framework' || dep.endsWith('/mcp-framework'))
    ) {
      throw new Error(
        "This directory is not an MCP project (mcp-framework not found in dependencies or devDependencies)"
      );
    }
  } catch (error) {
    console.error("Error: Must be run from an MCP project directory");
    logger.error(`Project validation failed: ${(error as Error).message}`);
    process.exit(1);
  }
}
