package bar.bto.meshsix.ui.navigation

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffold
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.vector.ImageVector
import bar.bto.meshsix.ui.screens.AgentsScreen
import bar.bto.meshsix.ui.screens.DashboardScreen
import bar.bto.meshsix.ui.screens.SettingsScreen

/**
 * Top-level admin destinations for the mesh-six portal.
 *
 * NavigationSuiteScaffold automatically renders:
 * - Bottom NavigationBar on compact windows (Pixel 10 Pro XL portrait)
 * - Side NavigationRail on medium/expanded windows (tablet, landscape)
 * - Persistent NavigationDrawer on extra-wide windows
 *
 * Zero manual breakpoint math required.
 */
enum class AdminDestination(
    val label: String,
    val icon: ImageVector,
    val contentDescription: String,
) {
    DASHBOARD("Dashboard", Icons.Default.Dashboard, "Dashboard home"),
    AGENTS("Agents", Icons.Default.Group, "Agent registry"),
    SETTINGS("Settings", Icons.Default.Settings, "App settings"),
}

@Composable
fun MainScaffold() {
    var currentDestination by rememberSaveable { mutableStateOf(AdminDestination.DASHBOARD) }

    NavigationSuiteScaffold(
        navigationSuiteItems = {
            AdminDestination.entries.forEach { destination ->
                item(
                    icon = {
                        Icon(
                            imageVector = destination.icon,
                            contentDescription = destination.contentDescription,
                        )
                    },
                    label = { Text(destination.label) },
                    selected = destination == currentDestination,
                    onClick = { currentDestination = destination },
                )
            }
        },
    ) {
        when (currentDestination) {
            AdminDestination.DASHBOARD -> DashboardScreen()
            AdminDestination.AGENTS -> AgentsScreen()
            AdminDestination.SETTINGS -> SettingsScreen()
        }
    }
}
