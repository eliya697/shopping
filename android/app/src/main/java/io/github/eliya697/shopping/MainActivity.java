package io.github.eliya697.shopping;

import android.os.Bundle;
import androidx.activity.EdgeToEdge;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Draw behind the status and navigation bars on every Android version (15+ forces it anyway).
        // The SystemBars plugin passes the bar sizes to the page as --safe-area-inset-* CSS variables.
        EdgeToEdge.enable(this);
        super.onCreate(savedInstanceState);
    }
}
