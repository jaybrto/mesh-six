package bar.bto.meshsix.ui.theme

import android.app.Activity
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

private val MeshSixColorScheme = darkColorScheme(
    primary = Mesh500,
    onPrimary = Zinc950,
    primaryContainer = Mesh600,
    onPrimaryContainer = Mesh300,
    secondary = Zinc600,
    onSecondary = Color.White,
    secondaryContainer = Zinc700,
    onSecondaryContainer = Zinc400,
    tertiary = InfoBlue,
    background = Zinc950,
    onBackground = Color.White,
    surface = Zinc900,
    onSurface = Color.White,
    surfaceVariant = Zinc800,
    onSurfaceVariant = Zinc400,
    outline = Zinc700,
    outlineVariant = Zinc800,
    error = ErrorRed,
    onError = Color.White,
    inverseSurface = Color.White,
    inverseOnSurface = Zinc950,
)

@Composable
fun MeshSixTheme(content: @Composable () -> Unit) {
    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as Activity).window
            window.statusBarColor = Color.Transparent.toArgb()
            window.navigationBarColor = Color.Transparent.toArgb()
            WindowCompat.getInsetsController(window, view).apply {
                isAppearanceLightStatusBars = false
                isAppearanceLightNavigationBars = false
            }
        }
    }

    MaterialTheme(
        colorScheme = MeshSixColorScheme,
        typography = MeshSixTypography,
        content = content,
    )
}
