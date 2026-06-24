import nfseIngestDefinition from "./definitions/nfse-ingest.json";
import smokeClassificationDefinition from "./definitions/smoke-classification.json";
import smokePipelineDefinition from "./definitions/smoke-pipeline.json";

export interface WorkflowDefinition {
  name: string;
  version: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

export const workflowDefinitions = [
  nfseIngestDefinition,
  smokeClassificationDefinition,
  smokePipelineDefinition,
] as WorkflowDefinition[];
