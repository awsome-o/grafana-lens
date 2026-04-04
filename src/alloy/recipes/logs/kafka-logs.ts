import type { PipelineRecipe, ResolvedParams } from "../types.js";
import type { ExportTargets } from "../../types.js";
import { AlloyConfigBuilder, componentLabel, escapeString, renderValue } from "../../config-builder.js";
import { credentialEnvVar } from "../types.js";
import { buildProcessBlock, extractProcessingParams, PROCESSING_OPTIONAL_PARAMS } from "./_process-builder.js";

const recipe: PipelineRecipe = {
  name: "kafka-logs",
  category: "logs",
  signal: "logs",
  summary: "Consume logs from Apache Kafka topics with optional JSON/label processing",
  dashboardTemplate: null,
  credentialParams: ["kafkaAuth"],

  requiredParams: [
    { name: "brokers", type: "string[]", description: "Kafka broker addresses", example: "kafka:9092" },
    { name: "topics", type: "string[]", description: "Kafka topics to consume", example: "app-logs" },
  ],

  optionalParams: [
    { name: "consumerGroup", type: "string", description: "Kafka consumer group ID", default: "alloy" },
    { name: "kafkaAuth", type: "string", description: "SASL credentials (user:password)", sensitive: true },
    ...PROCESSING_OPTIONAL_PARAMS,
  ],

  generateConfig(pipelineId: string, params: ResolvedParams, targets: ExportTargets, pipelineName: string): string {
    const brokers = params.brokers as string[];
    const topics = params.topics as string[];
    const consumerGroup = (params.consumerGroup as string) || "alloy";
    const kafkaAuth = params.kafkaAuth as string | undefined;
    const srcLabel = componentLabel(pipelineId, "kafka");
    const writeLabel = componentLabel(pipelineId, "write");

    const builder = new AlloyConfigBuilder();

    const processing = buildProcessBlock(
      pipelineId,
      extractProcessingParams(params),
      `loki.write.${writeLabel}.receiver`,
    );

    const forwardTo = processing
      ? processing.receiverRef
      : `loki.write.${writeLabel}.receiver`;

    const brokerList = renderValue(brokers);
    const topicList = renderValue(topics);

    let srcBlock = `loki.source.kafka "${srcLabel}" {
  brokers        = [${brokerList}]
  topics         = [${topicList}]
  consumer_group = "${escapeString(consumerGroup)}"
  forward_to     = [${forwardTo}]
  labels         = { source = "kafka" }`;

    if (kafkaAuth) {
      const userEnv = credentialEnvVar("kafka-logs", pipelineName, "kafkaAuth_user");
      const passEnv = credentialEnvVar("kafka-logs", pipelineName, "kafkaAuth_pass");
      srcBlock += `

  authentication {
    type = "sasl"
    sasl {
      mechanism = "PLAIN"
      username  = sys.env("${userEnv}")
      password  = sys.env("${passEnv}")
    }
  }`;
    }

    srcBlock += "\n}";
    builder.addBlock(srcBlock);

    if (processing) {
      builder.addBlock(processing.block);
    }

    builder.addBlock(`loki.write "${writeLabel}" {
  endpoint {
    url = "${escapeString(targets.lokiWriteUrl)}"
  }
}`);

    return builder.build(pipelineId, "kafka-logs", "kafka-logs");
  },

  sampleQueries() {
    return {
      recentLogs: '{source="kafka"}',
      errorLogs: '{source="kafka"} |= "error"',
      logVolume: 'rate({source="kafka"}[5m])',
    };
  },

  componentIds(pipelineId: string) {
    return [
      `loki.source.kafka.${componentLabel(pipelineId, "kafka")}`,
      `loki.write.${componentLabel(pipelineId, "write")}`,
    ];
  },
};

export default recipe;
