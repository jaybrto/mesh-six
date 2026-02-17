import { Routes, Route, NavLink } from "react-router-dom";
import { MqttProvider } from "./hooks/useMqtt";
import { AgentRegistryView } from "./views/AgentRegistry";
import { TaskFeedView } from "./views/TaskFeed";
import { ProjectLifecycleView } from "./views/ProjectLifecycle";

const navItems = [
  { to: "/", label: "Agents" },
  { to: "/tasks", label: "Tasks" },
  { to: "/projects", label: "Projects" },
] as const;

export function App() {
  return (
    <MqttProvider>
      <div className="flex min-h-screen flex-col">
        <header className="border-b border-zinc-800 bg-zinc-900/80 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-7xl items-center gap-8 px-4">
            <h1 className="text-lg font-semibold tracking-tight text-mesh-400">
              mesh-six
            </h1>
            <nav className="flex gap-1">
              {navItems.map(({ to, label }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={to === "/"}
                  className={({ isActive }) =>
                    `rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                      isActive
                        ? "bg-mesh-600/20 text-mesh-300"
                        : "text-zinc-400 hover:text-zinc-200"
                    }`
                  }
                >
                  {label}
                </NavLink>
              ))}
            </nav>
          </div>
        </header>

        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
          <Routes>
            <Route path="/" element={<AgentRegistryView />} />
            <Route path="/tasks" element={<TaskFeedView />} />
            <Route path="/projects" element={<ProjectLifecycleView />} />
          </Routes>
        </main>
      </div>
    </MqttProvider>
  );
}
