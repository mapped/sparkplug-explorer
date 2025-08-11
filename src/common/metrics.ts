import Long from "long";
import { UMetric, UTemplate } from "sparkplug-payload/lib/sparkplugbpayload";
import { Logger } from "../common/logger";

export function getMetricValue(
  metric: UMetric,
  logger: Logger
): number | boolean | string {
  let metricValue = null;

  switch (metric.type) {
    case "Int8":
    case "Int16":
    case "Int32":
    case "Int64":
    case "UInt8":
    case "UInt16":
    case "UInt32":
    case "UInt64":
    case "Float":
    case "Double":
      metricValue = makeNumber(metric.value);
      break;
    case "Boolean":
    case "String":
      metricValue = metric.value;
      break;
    case "Template":
      const template = metric.value as UTemplate;
      // Ignore template definitions
      if (template.isDefinition === true) {
        return null;
      }
      // Special handling for Baja Status
      if (template.templateRef.startsWith("baja:Status")) {
        const valueMetric = template.metrics.find((m) => {
          return m.name === "value";
        });
        if (!valueMetric) {
          logger
            .with()
            .any("template", template)
            .logger()
            .warn("❌ Template does not have value metric");
          return null;
        }
        metricValue = getMetricValue(valueMetric, logger);
      } else {
        logger
          .with()
          .any("template", template)
          .logger()
          .warn("❌ Unsupported template");
        return null;
      }
      break;
    case "DateTime":
    case "Text":
    case "UUID":
    case "DataSet":
    case "Bytes":
    case "File":
    default:
      return null;
  }
  return metricValue;
}

function makeNumber(value: any): number {
  if (typeof value === "number") {
    return value;
  } else if ("low" in value && "high" in value) {
    return value.toNumber();
  } else {
    throw new Error(`Unsupported value ${value}`);
  }
}

export function ts(timestamp: Long | number): Date {
  return new Date(
    typeof timestamp === "number" ? timestamp : timestamp.toNumber()
  );
}

export function tss(timestamp: Long) {
  return new Date(timestamp.toNumber()).toISOString();
}

export function resolveMetricName(metric: UMetric): string {
  let metricName = metric.name;

  if (metric.alias) {
    if (Long.isLong(metric.alias)) {
      metricName = metric.alias.toInt().toString();
    } else {
      metricName = metric.alias.toString();
    }
  }
  return metricName;
}
