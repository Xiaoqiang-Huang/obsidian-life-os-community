/** MCP's documented non-code-generating JSON Schema provider; no validation bypass. */
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";

// The SDK constructs the default AJV provider internally. The build adapter
// substitutes this interface-compatible implementation, not an always-pass shim.
export class AjvJsonSchemaValidator extends CfWorkerJsonSchemaValidator {
  constructor(customAjv?: unknown) {
    if (customAjv !== undefined) throw new Error("lifeos-custom-ajv-not-supported");
    super({ draft: "2020-12", shortcircuit: false });
  }
}
