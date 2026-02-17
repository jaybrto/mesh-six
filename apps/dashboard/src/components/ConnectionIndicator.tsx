import { useMqtt } from "../hooks/useMqtt";

export function ConnectionIndicator() {
  const { connected } = useMqtt();

  return (
    <div className="flex items-center gap-2 text-xs">
      <span
        className={`h-2 w-2 rounded-full ${
          connected ? "bg-emerald-500 shadow-sm shadow-emerald-500/50" : "bg-red-500"
        }`}
      />
      <span className={connected ? "text-emerald-400" : "text-red-400"}>
        {connected ? "MQTT connected" : "MQTT disconnected"}
      </span>
    </div>
  );
}
