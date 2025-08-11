import * as mqtt from "mqtt";
import type { IClientOptions, MqttClient } from "mqtt";
import events from "events";
import * as sparkplug from "sparkplug-payload";
import type { UPayload } from "sparkplug-payload/lib/sparkplugbpayload";
import type { Reader } from "protobufjs";
import pako from "pako";
import { Logger } from "../../common/logger";

const sparkplugbpayload = sparkplug.get("spBv1.0")!;

const compressed = "SPBV1.0_COMPRESSED";

function getRequiredProperty<
  C extends Record<string, unknown>,
  P extends keyof C & string
>(config: C, propName: P): C[P] {
  if (config[propName] !== undefined) {
    return config[propName];
  }
  throw new Error("Missing required configuration property '" + propName + "'");
}

function getProperty<C, P extends keyof C, DEFAULT extends C[P]>(
  config: C,
  propName: P,
  defaultValue: DEFAULT
): Exclude<C[P], undefined> | DEFAULT {
  if (config[propName] !== undefined) {
    return config[propName] as Exclude<C[P], undefined>;
  } else {
    return defaultValue;
  }
}

export type SparkplugHostApplicationClientOptions = {
  serverUrl: string;
  username?: string;
  password?: string;
  clientId: string;
  version?: string;
  keepalive?: number;
  logger: Logger;
  hostId: string;
  mqttOptions?: Omit<
    IClientOptions,
    | "clientId"
    | "clean"
    | "keepalive"
    | "reschedulePings"
    | "connectTimeout"
    | "username"
    | "password"
    | "will"
  >;
};

export type PayloadOptions = {
  algorithm?: "GZIP" | "DEFLATE";
  /** @default false */
  compress?: boolean;
};

export type MessageContext = {
  namespace: string;
  groupId: string;
  messageType:
    | "NBIRTH"
    | "NDEATH"
    | "DBIRTH"
    | "DDEATH"
    | "NDATA"
    | "DDATA"
    | "NCMD"
    | "DCMD"
    | "STATE";
  edgeNodeId: string;
  deviceId: string | null;
  otherParts: string[];
};

export interface SparkplugHostApplicationClient extends events.EventEmitter {
  /** MQTT client event */
  on(
    event: "connect" | "close" | "reconnect" | "offline" | "birth" | "end",
    listener: () => void
  ): this;
  on(
    event: "disconnect",
    listener: (packet: mqtt.IDisconnectPacket) => void
  ): this;
  /** MQTT client event */
  on(event: "error", listener: (error: Error) => void): this;
  /** emitted when a payload is received with a version unsupported by this client */
  on(
    event: "message",
    listener: (
      topic: string,
      payload: UPayload,
      context: MessageContext
    ) => void
  ): this;

  emit(
    event: "connect" | "close" | "reconnect" | "offline" | "birth" | "end"
  ): boolean;
  emit(event: "error", error: Error): boolean;
  emit(event: "disconnect", packet: mqtt.IDisconnectPacket): boolean;
  emit(
    event: "message",
    topic: string,
    payload: UPayload,
    context: MessageContext
  ): boolean;
}

export { UPayload };

/*
 * Sparkplug Client
 */
export class SparkplugHostApplicationClient extends events.EventEmitter {
  // Constants
  private readonly versionB: string = "spBv1.0";

  // Config Variables
  private serverUrl: string;
  private version: string;
  private mqttOptions: IClientOptions;

  // Will be used once we start sending commands
  // private bdSeq = 0

  // MQTT Client Variables
  private seq = 0;
  private client: null | MqttClient = null;
  private connecting = false;
  private connected = false;
  private birthTime = new Date().getTime();
  private hostId: string;

  private logger: Logger;

  private birthTopic: string;

  constructor(config: SparkplugHostApplicationClientOptions) {
    super();
    this.logger = getRequiredProperty(config, "logger");

    this.version = getProperty(config, "version", this.versionB);

    // Client connection options
    this.serverUrl = getRequiredProperty(config, "serverUrl");
    this.hostId = getRequiredProperty(config, "hostId");

    const username = getProperty(config, "username", undefined);
    const password = getProperty(config, "password", undefined);
    const clientId = getRequiredProperty(config, "clientId");
    const keepalive = getProperty(config, "keepalive", 300); // 5 minutes

    this.birthTopic = `${this.version}/STATE/${this.hostId}`;

    this.mqttOptions = {
      ...(config.mqttOptions || {}), // allow additional options
      clientId,
      clean: true,
      keepalive,
      reschedulePings: false,
      connectTimeout: 30000,
      username,
      password,
      properties: {
        sessionExpiryInterval: 0,
      },
      will: {
        topic: this.birthTopic,
        payload: Buffer.from(
          JSON.stringify({
            online: false,
            // FIXME: MUST be the same value that was used for the timestamp in its own prior MQTT CONNECT packet Will Message payload.
            timestamp: Date.now(),
          })
        ),
        qos: 1,
        retain: true,
      },
    };

    this.init();
  }

  // Increments a sequence number
  private incrementSeqNum(): number {
    if (this.seq == 256) {
      this.seq = 0;
    }
    return this.seq++;
  }

  private encodePayload(payload: UPayload): Uint8Array {
    return sparkplugbpayload.encodePayload(payload);
  }

  private decodePayload(payload: Uint8Array | Reader): UPayload {
    try {
      return sparkplugbpayload.decodePayload(payload);
    } catch (e) {
      // not a sparkplug payload
      throw new Error("Failed to decode Sparkplug payload");
    }
  }

  private addSeqNumber(payload: UPayload): void {
    payload.seq = this.incrementSeqNum();
  }

  private compressPayload(
    payload: Uint8Array,
    options?: PayloadOptions
  ): UPayload {
    let algorithm: NonNullable<PayloadOptions["algorithm"]> | null = null;
    let resultPayload: UPayload = {
      uuid: compressed,
      metrics: [],
    };

    this.logger.debug("Compressing payload " + JSON.stringify(options));

    // See if any options have been set
    if (options !== undefined && options !== null) {
      // Check algorithm
      if (options["algorithm"]) {
        algorithm = options["algorithm"];
      }
    }

    if (algorithm === null || algorithm.toUpperCase() === "DEFLATE") {
      this.logger.debug("Compressing with DEFLATE!");
      resultPayload.body = pako.deflate(payload);
    } else if (algorithm.toUpperCase() === "GZIP") {
      this.logger.debug("Compressing with GZIP");
      resultPayload.body = pako.gzip(payload);
    } else {
      throw new Error("Unknown or unsupported algorithm " + algorithm);
    }

    // Create and add the algorithm metric if is has been specified in the options
    if (algorithm !== null) {
      resultPayload.metrics = [
        {
          name: "algorithm",
          value: algorithm.toUpperCase(),
          type: "String",
        },
      ];
    }

    return resultPayload;
  }

  private decompressPayload(payload: UPayload): Uint8Array {
    let metrics = payload.metrics || [],
      algorithm: null | NonNullable<PayloadOptions["algorithm"]> = null;
    const body = payload.body || new Uint8Array();

    this.logger.debug("Decompressing payload");

    const algorithmMetric = metrics.find((m) => m.name === "algorithm");
    if (algorithmMetric && typeof algorithmMetric.value === "string") {
      algorithm = algorithmMetric.value as NonNullable<
        PayloadOptions["algorithm"]
      >;
    }

    if (algorithm === null || algorithm.toUpperCase() === "DEFLATE") {
      this.logger.debug("Decompressing with DEFLATE!");
      return pako.inflate(body);
    } else if (algorithm.toUpperCase() === "GZIP") {
      this.logger.debug("Decompressing with GZIP");
      return pako.ungzip(body);
    } else {
      throw new Error("Unknown or unsupported algorithm " + algorithm);
    }
  }

  private maybeDecompressPayload(payload: UPayload): UPayload {
    if (payload.uuid !== undefined && payload.uuid === compressed) {
      // Decompress the payload
      return this.decodePayload(this.decompressPayload(payload));
    } else {
      // The payload is not compressed
      return payload;
    }
  }

  subscribeTopic(
    topic: string,
    options: mqtt.IClientSubscribeOptions,
    callback?: mqtt.ClientSubscribeCallback
  ) {
    this.logger
      .with()
      .any("options", options)
      .logger()
      .info(`Subscribing to topic: ${topic}`);
    this.client!.subscribe(topic, options, callback);
  }

  unsubscribeTopic(
    topic: string,
    options?: any,
    callback?: mqtt.PacketCallback
  ) {
    this.logger.info(`Unsubscribing topic: ${topic}`);
    this.client!.unsubscribe(topic, options, callback);
  }

  stop() {
    this.client?.end();
  }

  // Configures and connects the client
  private init() {
    // Connect to the MQTT server
    this.connecting = true;
    this.logger.info("Attempting to connect: " + this.serverUrl);
    this.client = mqtt.connect(this.serverUrl, this.mqttOptions);

    /*
     * 'connect' handler
     */
    this.client.on("connect", () => {
      this.logger.info("Client has connected");
      this.connecting = false;
      this.connected = true;

      this.subscribeTopic(`#`, { qos: 1 }, () => {
        this.logger.info("Subscribed to all topics");
        // Subscribe to the birth topic
        this.subscribeTopic(this.birthTopic, { qos: 1 }, () => {
          // Publish the birth message
          this.client!.publish(
            this.birthTopic,
            JSON.stringify({
              online: true,
              timestamp: this.birthTime,
            }),
            { qos: 1, retain: true },
            () => {
              this.emit("birth");
              this.logger.info("Published birth message");
            }
          );
        });
      });

      this.emit("connect");
    });

    /*
     * 'error' handler
     */
    this.client.on("error", (error) => {
      if (this.connecting) {
        this.emit("error", error);
        this.client!.end();
      }
    });

    /*
     * 'close' handler
     */
    this.client.on("close", () => {
      if (this.connected) {
        this.connected = false;
        this.emit("close");
      }
    });

    /*
     * 'disconnect' handler
     */
    this.client.on("disconnect", (packet) => {
      this.emit("disconnect", packet);
    });

    /*
     * 'reconnect' handler
     */
    this.client.on("reconnect", () => {
      this.emit("reconnect");
    });

    /*
     * 'offline' handler
     */
    this.client.on("offline", () => {
      this.emit("offline");
    });

    this.client.on("end", () => {
      this.emit("end");
    });

    /*
     * 'packetsend' handler
     */
    this.client.on("packetsend", (packet) => {
      // Don't log ack packets
      if (!packet.cmd.includes("ack") && this.logger.isDebugEnabled()) {
        this.logger
          .with()
          .any("packet", packet)
          .logger()
          .debug("Sending MQTT Packet");
      }
    });

    // /*
    //  * 'packetreceive' handler
    //  */
    // this.client.on('packetreceive', (packet) => {
    //   if (this.logger.isDebugEnabled()) {
    //     this.logger
    //       .with()
    //       .any('packet', packet)
    //       .logger()
    //       .trace('Received MQTT Packet')
    //   }
    // })

    /*
     * 'message' handler
     */
    this.client.on("message", (topic, message) => {
      let decoded: UPayload;
      try {
        decoded = this.decodePayload(message);
      } catch (e) {
        this.logger.debug(
          "Received message with unsupported payload version: " + topic
        );
        return;
      }
      let payload = this.maybeDecompressPayload(decoded);
      if (this.logger.isTraceEnabled()) {
        this.logger
          .with()
          .str("topic", topic)
          .any("payload", payload)
          .logger()
          .trace(`Received message on topic ${topic}`);
      }
      this.emit("message", topic, payload, parseTopic(topic));
    });
  }
}

export function newClient(
  config: SparkplugHostApplicationClientOptions
): SparkplugHostApplicationClient {
  return new SparkplugHostApplicationClient(config);
}

export function parseCertificateTopic(topic: string): MessageContext {
  return parseTopic(topic.split("/").slice(2).join("/"));
}

// Parse the sparkplug topic and return and object with the relevant parts
export function parseTopic(topic: string): MessageContext {
  const parts = topic.split("/");
  const namespace = parts[0];
  const groupId = parts[1];
  const messageType = parts[2] as MessageContext["messageType"];
  const edgeNodeId = parts[3];
  const deviceId = parts.length >= 5 ? parts[4] : null;

  let otherParts: string[] = [];
  if (parts.length > 5) {
    otherParts = parts.slice(5);
  }

  return {
    namespace,
    groupId,
    messageType,
    edgeNodeId,
    deviceId,
    otherParts,
  };
}
