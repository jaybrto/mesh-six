package bar.bto.meshsix

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import bar.bto.meshsix.ui.navigation.MainScaffold
import bar.bto.meshsix.ui.theme.MeshSixTheme
import dagger.hilt.android.AndroidEntryPoint

@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            MeshSixTheme {
                MainScaffold()
            }
        }
    }
}
