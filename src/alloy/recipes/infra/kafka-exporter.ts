import type { PipelineRecipe, ResolvedParams } from "../types.js";
import type { ExportTargets } from "../../types.js";
import { AlloyConfigBuilder, componentLabel, escapeString, renderValue } from "../../config-builder.js";

const recipe: PipelineRecipe = {
  name: "kafka-exporter",
  category: "infrastructure",
  signal: "metrics",
  summary: "Kafka cluster metrics — brokers, topics, consumer groups, lag",
  dashboardTemplate: "metric-explorer",
  credentialParams: [],

  requiredParams: [
    { name: "kafkaBrokers", type: "string[]", description: "Kafka broker addresses", example: "kafka:9092" },
  ],

  optionalParams: [
    { name: "topics", type: "string[]", description: "Topics to monitor (empty = all)" },
    { name: "scrapeInterval", type: "string", description: "Scrape interval", default: "15s" },
  ],

  generateConfig(pipelineId: string, params: ResolvedParams, targets: ExportTargets, _pipelineName: string): string {
    const brokers = params.kafkaBrokers as string[];
    const scrapeInterval = (params.scrapeInterval as string) || "15s";
    const jobName = (params.jobName as string) || "kafka";
    const exp = componentLabel(pipelineId, "kafka");
    const scr = componentLabel(pipelineId, "scrape");
    const rel = componentLabel(pipelineId, "relabel");
    const wr = componentLabel(pipelineId, "write");

    return new AlloyConfigBuilder()
      .addBlock(`prometheus.exporter.kafka "${exp}" {\n  kafka_uris = ${renderValue(brokers)}\n}`)
      .addBlock(`prometheus.scrape "${scr}" {\n  targets         = prometheus.exporter.kafka.${exp}.targets\n  forward_to      = [prometheus.relabel.${rel}.receiver]\n  job_name        = "${escapeString(jobName)}"\n  scrape_interval = "${escapeString(scrapeInterval)}"\n}`)
      .addBlock(`prometheus.relabel "${rel}" {\n  forward_to = [prometheus.remote_write.${wr}.receiver]\n  rule {\n    target_label = "job"\n    replacement  = "${escapeString(jobName)}"\n  }\n}`)
      .addBlock(`prometheus.remote_write "${wr}" {\n  endpoint {\n    url = "${escapeString(targets.prometheusRemoteWriteUrl)}"\n  }\n}`)
      .build(pipelineId, "kafka-exporter", "kafka");
  },

  sampleQueries(_params: ResolvedParams, jobName: string) {
    return { brokerCount: `count(kafka_broker_info{job="${jobName}"})`, consumerLag: `kafka_consumergroup_lag{job="${jobName}"}` };
  },

  componentIds(pipelineId: string) {
    return [`prometheus.exporter.kafka.${componentLabel(pipelineId, "kafka")}`, `prometheus.scrape.${componentLabel(pipelineId, "scrape")}`, `prometheus.relabel.${componentLabel(pipelineId, "relabel")}`, `prometheus.remote_write.${componentLabel(pipelineId, "write")}`];
  },
};

export default recipe;
