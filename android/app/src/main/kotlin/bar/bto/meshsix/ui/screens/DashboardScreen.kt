package bar.bto.meshsix.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import bar.bto.meshsix.ui.theme.Mesh300
import bar.bto.meshsix.ui.theme.Mesh500

/**
 * Dashboard home screen with summary metric cards.
 *
 * Uses LazyVerticalGrid with GridCells.Adaptive(minSize = 160.dp) so the grid
 * automatically fills 2 columns on the Pixel 10 Pro XL, 3-4 on the 12.2" tablet,
 * without manual breakpoint math.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DashboardScreen() {
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = "mesh-six",
                        fontWeight = FontWeight.SemiBold,
                        color = Mesh300,
                    )
                },
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
                .padding(horizontal = 16.dp),
        ) {
            // Connection status banner
            Card(
                colors = CardDefaults.cardColors(
                    containerColor = Mesh500.copy(alpha = 0.12f),
                ),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Row(modifier = Modifier.padding(16.dp)) {
                    Text(
                        text = "\u25CF",
                        color = Mesh500,
                    )
                    Text(
                        text = " Connected \u2022 LAN TCP",
                        style = MaterialTheme.typography.bodyMedium,
                        color = Mesh300,
                    )
                }
            }

            Spacer(Modifier.height(16.dp))

            // Summary metric cards — adaptive grid
            LazyVerticalGrid(
                columns = GridCells.Adaptive(minSize = 160.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
                modifier = Modifier.weight(1f),
            ) {
                items(summaryCards) { card ->
                    SummaryCard(
                        title = card.title,
                        value = card.value,
                        subtitle = card.subtitle,
                    )
                }
            }
        }
    }
}

@Composable
private fun SummaryCard(
    title: String,
    value: String,
    subtitle: String,
    modifier: Modifier = Modifier,
) {
    Card(
        modifier = modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant,
        ),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(
                text = title,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(8.dp))
            Text(
                text = value,
                fontSize = 32.sp,
                fontWeight = FontWeight.Bold,
                color = Mesh300,
            )
            Spacer(Modifier.height(4.dp))
            Text(
                text = subtitle,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

private data class SummaryCardData(
    val title: String,
    val value: String,
    val subtitle: String,
)

private val summaryCards = listOf(
    SummaryCardData("Active Sessions", "3", "2 tools/min avg"),
    SummaryCardData("Agents Online", "7", "1 degraded"),
    SummaryCardData("Tasks (1h)", "47", "94% success"),
    SummaryCardData("Projects", "2", "1 in QA"),
    SummaryCardData("LLM Actors", "4", "2 idle, 1 busy"),
    SummaryCardData("Events Today", "1,247", "12 errors"),
)
