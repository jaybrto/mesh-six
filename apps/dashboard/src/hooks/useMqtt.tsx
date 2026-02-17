import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import mqtt, { type MqttClient } from "mqtt";

interface MqttContextValue {
  client: MqttClient | null;
  connected: boolean;
  subscribe: (topic: string, handler: (topic: string, payload: string) => void) => () => void;
}

const MqttContext = createContext<MqttContextValue>({
  client: null,
  connected: false,
  subscribe: () => () => {},
});

const MQTT_URL = import.meta.env.VITE_MQTT_URL || "ws://localhost:1883";

const TOPICS = [
  "agent/registry/#",
  "agent/task/#",
  "agent/project/#",
] as const;

export function MqttProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const clientRef = useRef<MqttClient | null>(null);
  const handlersRef = useRef<Map<string, Set<(topic: string, payload: string) => void>>>(
    new Map(),
  );

  useEffect(() => {
    const client = mqtt.connect(MQTT_URL, {
      clientId: `mesh-six-dashboard-${Date.now()}`,
      reconnectPeriod: 5000,
      connectTimeout: 10000,
    });

    client.on("connect", () => {
      setConnected(true);
      for (const topic of TOPICS) {
        client.subscribe(topic);
      }
    });

    client.on("close", () => setConnected(false));
    client.on("offline", () => setConnected(false));

    client.on("message", (topic, message) => {
      const payload = message.toString();
      for (const [pattern, handlers] of handlersRef.current) {
        if (topicMatches(pattern, topic)) {
          for (const handler of handlers) {
            handler(topic, payload);
          }
        }
      }
    });

    clientRef.current = client;

    return () => {
      client.end(true);
      clientRef.current = null;
    };
  }, []);

  const subscribe = useCallback(
    (topic: string, handler: (topic: string, payload: string) => void) => {
      const existing = handlersRef.current.get(topic);
      if (existing) {
        existing.add(handler);
      } else {
        handlersRef.current.set(topic, new Set([handler]));
      }
      return () => {
        const set = handlersRef.current.get(topic);
        if (set) {
          set.delete(handler);
          if (set.size === 0) handlersRef.current.delete(topic);
        }
      };
    },
    [],
  );

  return (
    <MqttContext.Provider value={{ client: clientRef.current, connected, subscribe }}>
      {children}
    </MqttContext.Provider>
  );
}

export function useMqtt() {
  return useContext(MqttContext);
}

export function useMqttSubscription(
  topic: string,
  handler: (topic: string, payload: string) => void,
) {
  const { subscribe } = useMqtt();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    return subscribe(topic, (t, p) => handlerRef.current(t, p));
  }, [subscribe, topic]);
}

/** Check if a topic matches an MQTT wildcard pattern */
function topicMatches(pattern: string, topic: string): boolean {
  if (pattern === "#") return true;
  const patParts = pattern.split("/");
  const topParts = topic.split("/");

  for (let i = 0; i < patParts.length; i++) {
    if (patParts[i] === "#") return true;
    if (patParts[i] === "+") continue;
    if (patParts[i] !== topParts[i]) return false;
  }

  return patParts.length === topParts.length;
}
