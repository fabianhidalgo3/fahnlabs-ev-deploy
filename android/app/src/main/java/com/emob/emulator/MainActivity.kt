package com.emob.emulator

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.graphics.Color
import com.emob.emulator.ui.ChargerScreen

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            val scheme = if (isSystemInDarkTheme()) {
                darkColorScheme(primary = Color(0xFF2DD4BF), secondary = Color(0xFF38BDF8))
            } else {
                lightColorScheme(primary = Color(0xFF0F766E), secondary = Color(0xFF0369A1))
            }
            MaterialTheme(colorScheme = scheme) {
                ChargerScreen()
            }
        }
    }
}
