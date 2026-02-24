package bar.bto.meshsix.ui.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import bar.bto.meshsix.BuildConfig

/**
 * Settings screen placeholder. Will be expanded in Feature 12 with
 * MQTT endpoint configuration, notification toggles, background service
 * controls, and connectivity diagnostics.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen() {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = Color.Transparent,
                ),
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(horizontal = 16.dp)
                .verticalScroll(rememberScrollState()),
        ) {
            SectionHeader("Connection")
            SettingsInfoCard("MQTT LAN", BuildConfig.DEFAULT_MQTT_LAN)
            Spacer(Modifier.height(8.dp))
            SettingsInfoCard("MQTT WSS", BuildConfig.DEFAULT_MQTT_WSS)
            Spacer(Modifier.height(8.dp))
            SettingsInfoCard("API Base", BuildConfig.DEFAULT_API_BASE)

            Spacer(Modifier.height(24.dp))
            SectionHeader("Notifications")
            SettingsInfoCard("ntfy Server", BuildConfig.DEFAULT_NTFY_URL)
            Spacer(Modifier.height(8.dp))
            SettingsInfoCard("ntfy Topic", "mesh-six-alerts")

            Spacer(Modifier.height(24.dp))
            SectionHeader("About")
            SettingsInfoCard("Version", "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
            Spacer(Modifier.height(8.dp))
            SettingsInfoCard("Package", BuildConfig.APPLICATION_ID)
            Spacer(Modifier.height(8.dp))
            SettingsInfoCard("Build Type", BuildConfig.BUILD_TYPE)

            Spacer(Modifier.height(32.dp))
        }
    }
}

@Composable
private fun SectionHeader(title: String) {
    Text(
        text = title,
        style = MaterialTheme.typography.titleMedium,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.padding(vertical = 12.dp),
    )
}

@Composable
private fun SettingsInfoCard(label: String, value: String) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant,
        ),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(
                text = label,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(4.dp))
            Text(
                text = value,
                style = MaterialTheme.typography.bodyMedium,
                fontFamily = FontFamily.Monospace,
            )
        }
    }
}
