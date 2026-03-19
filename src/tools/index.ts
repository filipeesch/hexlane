// Re-export registry for use in src/index.ts
export { toolRegistry } from "./registry.js";

// Side-effect imports: each file self-registers its tool handler
import "./sql.js";
import "./http.js";
import "./fs.js";
