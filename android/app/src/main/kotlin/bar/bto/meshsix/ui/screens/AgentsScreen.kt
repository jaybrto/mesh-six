package bar.bto.meshsix.ui.screens

import android.os.Parcelable
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.adaptive.ExperimentalMaterial3AdaptiveApi
import androidx.compose.material3.adaptive.layout.AnimatedPane
import androidx.compose.material3.adaptive.layout.ListDetailPaneScaffoldRole
import androidx.compose.material3.adaptive.navigation.NavigableListDetailPaneScaffold
import androidx.compose.material3.adaptive.navigation.rememberListDetailPaneScaffoldNavigator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import bar.bto.meshsix.ui.theme.ErrorRed
import bar.bto.meshsix.ui.theme.Mesh300
import bar.bto.meshsix.ui.theme.Mesh500
import bar.bto.meshsix.ui.theme.Mesh600
import bar.bto.meshsix.ui.theme.WarningYellow
import bar.bto.meshsix.ui.theme.Zinc700
import kotlinx.coroutines.launch
import kotlinx.parcelize.Parcelize

// ---------------------------------------------------------------------------
// Mock data model — will be replaced by real AgentRegistration from MQTT
// ---------------------------------------------------------------------------

@Parcelize
data class MockAgent(
    val appId: String,
    val name: String,
    val status: String,
    val capabilities: List<String>,
    val lastHeartbeat: String,
    val healthChecks: Map<String, String> = emptyMap(),
    val version: String = "0.3.0",
) : Parcelable

private val mockAgents = listOf(
    MockAgent(
        appId = "orchestrator",
        name = "Orchestrator",
        status = "online",
        capabilities = listOf("general-query", "deploy", "code-review"),
        lastHeartbeat = "2s ago",
        healthChecks = mapOf("pg" to "healthy", "redis" to "healthy"),
    ),
    MockAgent(
        appId = "architect-agent",
        name = "Architect Agent",
        status = "online",
        capabilities = listOf("tech-consultation", "architecture-review"),
        lastHeartbeat = "8s ago",
        healthChecks = mapOf("ollama" to "healthy", "pg" to "healthy"),
    ),
    MockAgent(
        appId = "researcher-agent",
        name = "Researcher Agent",
        status = "online",
        capabilities = listOf("research", "web-search", "doc-analysis"),
        lastHeartbeat = "5s ago",
        healthChecks = mapOf("ollama" to "healthy"),
    ),
    MockAgent(
        appId = "argocd-deployer",
        name = "ArgoCD Deployer",
        status = "degraded",
        capabilities = listOf("deploy-service", "sync-gitops"),
        lastHeartbeat = "2m ago",
        healthChecks = mapOf("argocd" to "degraded", "gitea" to "healthy"),
    ),
    MockAgent(
        appId = "simple-agent",
        name = "Simple Agent",
        status = "online",
        capabilities = listOf("echo", "ping"),
        lastHeartbeat = "12s ago",
    ),
    MockAgent(
        appId = "project-manager",
        name = "Project Manager",
        status = "online",
        capabilities = listOf("project-planning", "task-breakdown", "status-reporting"),
        lastHeartbeat = "3s ago",
        healthChecks = mapOf("pg" to "healthy", "github" to "healthy"),
        version = "0.4.0",
    ),
    MockAgent(
        appId = "llm-service",
        name = "LLM Service",
        status = "online",
        capabilities = listOf("chat-completion", "code-generation"),
        lastHeartbeat = "1s ago",
        healthChecks = mapOf("ollama" to "healthy", "minio" to "healthy"),
        version = "0.2.0",
    ),
    MockAgent(
        appId = "board-watcher",
        name = "Board Watcher",
        status = "offline",
        capabilities = listOf("github-projects-monitor"),
        lastHeartbeat = "15m ago",
        healthChecks = mapOf("github" to "unreachable"),
        version = "0.1.0",
    ),
)

// ---------------------------------------------------------------------------
// Agents screen — NavigableListDetailPaneScaffold
// ---------------------------------------------------------------------------

/**
 * Agent Registry screen using NavigableListDetailPaneScaffold.
 *
 * - Tablet / expanded window: persistent side-by-side list + detail panes
 * - Phone / compact window: full-screen list, navigate to detail with
 *   predictive back gesture support
 *
 * No manual breakpoint calculations — the scaffold handles everything.
 */
@OptIn(ExperimentalMaterial3AdaptiveApi::class)
@Composable
fun AgentsScreen() {
    val navigator = rememberListDetailPaneScaffoldNavigator<MockAgent>()
    val scope = rememberCoroutineScope()

    NavigableListDetailPaneScaffold(
        navigator = navigator,
        listPane = {
            AnimatedPane {
                AgentListPane(
                    agents = mockAgents,
                    selectedAgent = navigator.currentDestination?.contentKey,
                    onAgentClick = { agent ->
                        scope.launch {
                            navigator.navigateTo(
                                pane = ListDetailPaneScaffoldRole.Detail,
                                contentKey = agent,
                            )
                        }
                    },
                )
            }
        },
        detailPane = {
            AnimatedPane {
                val selectedAgent = navigator.currentDestination?.contentKey
                if (selectedAgent != null) {
                    AgentDetailPane(agent = selectedAgent)
                } else {
                    AgentDetailEmpty()
                }
            }
        },
    )
}

// ---------------------------------------------------------------------------
// List pane
// ---------------------------------------------------------------------------

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AgentListPane(
    agents: List<MockAgent>,
    selectedAgent: MockAgent?,
    onAgentClick: (MockAgent) -> Unit,
) {
    val onlineCount = agents.count { it.status == "online" }
    val degradedCount = agents.count { it.status == "degraded" }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Agents") },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = Color.Transparent,
                ),
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            // Summary header
            item {
                Text(
                    text = "${agents.size} agents \u2022 $onlineCount online \u2022 $degradedCount degraded",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                )
            }

            items(agents, key = { it.appId }) { agent ->
                val isSelected = agent.appId == selectedAgent?.appId

                ListItem(
                    headlineContent = {
                        Text(
                            text = agent.name,
                            fontWeight = FontWeight.Medium,
                        )
                    },
                    supportingContent = {
                        Column {
                            Text(
                                text = agent.appId,
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Spacer(Modifier.height(4.dp))
                            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                agent.capabilities.take(3).forEach { cap ->
                                    CapabilityChip(name = cap)
                                }
                                if (agent.capabilities.size > 3) {
                                    Text(
                                        text = "+${agent.capabilities.size - 3}",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            }
                        }
                    },
                    trailingContent = {
                        Column(horizontalAlignment = Alignment.End) {
                            StatusDot(status = agent.status)
                            Spacer(Modifier.height(4.dp))
                            Text(
                                text = agent.lastHeartbeat,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    },
                    colors = ListItemDefaults.colors(
                        containerColor = if (isSelected)
                            Mesh600.copy(alpha = 0.12f)
                        else
                            Color.Transparent,
                    ),
                    modifier = Modifier.fillMaxWidth(),
                )
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Detail pane
// ---------------------------------------------------------------------------

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AgentDetailPane(agent: MockAgent) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(agent.name) },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = Color.Transparent,
                ),
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            // Identity card
            item {
                Card(
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.surfaceVariant,
                    ),
                ) {
                    Column(modifier = Modifier.padding(16.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                text = agent.appId,
                                style = MaterialTheme.typography.labelMedium,
                                fontFamily = FontFamily.Monospace,
                            )
                            Spacer(Modifier.width(8.dp))
                            StatusDot(status = agent.status)
                            Spacer(Modifier.width(4.dp))
                            Text(
                                text = agent.status,
                                style = MaterialTheme.typography.labelSmall,
                                color = statusColor(agent.status),
                            )
                        }
                        Spacer(Modifier.height(4.dp))
                        Text(
                            text = "Last heartbeat: ${agent.lastHeartbeat}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Text(
                            text = "Version: ${agent.version}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }

            // Capabilities section
            item {
                Text(
                    text = "Capabilities",
                    style = MaterialTheme.typography.titleMedium,
                )
            }
            item {
                Card(
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.surfaceVariant,
                    ),
                ) {
                    Column(modifier = Modifier.padding(16.dp)) {
                        agent.capabilities.forEachIndexed { index, cap ->
                            if (index > 0) {
                                HorizontalDivider(
                                    modifier = Modifier.padding(vertical = 8.dp),
                                    color = MaterialTheme.colorScheme.outlineVariant,
                                )
                            }
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                CapabilityChip(name = cap)
                            }
                        }
                    }
                }
            }

            // Health checks section
            if (agent.healthChecks.isNotEmpty()) {
                item {
                    Text(
                        text = "Health Checks",
                        style = MaterialTheme.typography.titleMedium,
                    )
                }
                item {
                    Card(
                        colors = CardDefaults.cardColors(
                            containerColor = MaterialTheme.colorScheme.surfaceVariant,
                        ),
                    ) {
                        Column(modifier = Modifier.padding(16.dp)) {
                            agent.healthChecks.entries.forEachIndexed { index, (dep, status) ->
                                if (index > 0) Spacer(Modifier.height(8.dp))
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(
                                        text = dep,
                                        style = MaterialTheme.typography.bodyMedium,
                                        fontFamily = FontFamily.Monospace,
                                    )
                                    Spacer(Modifier.weight(1f))
                                    StatusDot(status = if (status == "healthy") "online" else "degraded")
                                    Spacer(Modifier.width(4.dp))
                                    Text(
                                        text = status,
                                        style = MaterialTheme.typography.labelSmall,
                                        color = if (status == "healthy") Mesh500 else WarningYellow,
                                    )
                                }
                            }
                        }
                    }
                }
            }

            // Bottom spacer
            item { Spacer(Modifier.height(16.dp)) }
        }
    }
}

@Composable
private fun AgentDetailEmpty() {
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = "Select an agent to view details",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

// ---------------------------------------------------------------------------
// Shared components
// ---------------------------------------------------------------------------

@Composable
private fun StatusDot(status: String, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .size(8.dp)
            .clip(CircleShape)
            .background(statusColor(status)),
    )
}

private fun statusColor(status: String): Color = when (status) {
    "online" -> Mesh500
    "degraded" -> WarningYellow
    "offline" -> ErrorRed
    else -> Zinc700
}

@Composable
private fun CapabilityChip(name: String, modifier: Modifier = Modifier) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(12.dp),
        color = Mesh600.copy(alpha = 0.20f),
    ) {
        Text(
            text = name,
            style = MaterialTheme.typography.labelSmall,
            color = Mesh300,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
        )
    }
}
