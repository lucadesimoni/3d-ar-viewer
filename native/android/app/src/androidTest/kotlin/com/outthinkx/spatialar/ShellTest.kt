package com.outthinkx.spatialar

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.net.Uri
import androidx.test.core.app.ActivityScenario
import androidx.test.espresso.intent.Intents
import androidx.test.espresso.intent.Intents.intended
import androidx.test.espresso.intent.Intents.intending
import androidx.test.espresso.intent.matcher.IntentMatchers.hasAction
import androidx.test.espresso.intent.matcher.IntentMatchers.hasData
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import org.hamcrest.Matchers.allOf
import org.json.JSONArray
import org.json.JSONTokener
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.net.URLEncoder
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The real app, on an emulator, driven through its web view.
 *
 * The pages are the debug build's test assets (`src/debug/assets`), served at
 * https://appassets.androidplatform.net: a real https origin on the bridge's
 * allow list, with no network. The emulator has no ARCore, so the AR session
 * is expected to fail, and to say so, which is a path real phones take too.
 */
@RunWith(AndroidJUnit4::class)
class ShellTest {
    @get:Rule val camera: GrantPermissionRule = GrantPermissionRule.grant(android.Manifest.permission.CAMERA)

    private var scenario: ActivityScenario<MainActivity>? = null

    @After fun close() {
        scenario?.close()
    }

    private fun launch(page: String): ActivityScenario<MainActivity> {
        val link = "spatialar://open?url=" + URLEncoder.encode(page, "UTF-8")
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(link))
            .setClass(InstrumentationRegistry.getInstrumentation().targetContext, MainActivity::class.java)
        return ActivityScenario.launch<MainActivity>(intent).also { scenario = it }
    }

    /** Runs `script` in the page and returns its result as JSON text. */
    private fun js(s: ActivityScenario<MainActivity>, script: String): String {
        var result = "null"
        val done = CountDownLatch(1)
        s.onActivity { a -> a.web.evaluateJavascript(script) { v -> result = v ?: "null"; done.countDown() } }
        assertTrue("page did not answer: $script", done.await(5, TimeUnit.SECONDS))
        return result
    }

    /** Polls `script` until it returns `expected`, or fails with what it last returned. */
    private fun waitFor(s: ActivityScenario<MainActivity>, script: String, expected: String, timeoutMs: Long = 15_000) {
        val until = System.currentTimeMillis() + timeoutMs
        var last = ""
        while (System.currentTimeMillis() < until) {
            last = js(s, script)
            if (last == expected) return
            Thread.sleep(200)
        }
        assertEquals("waiting for: $script", expected, last)
    }

    /** The page's `received` messages, as `type[:state]` strings. */
    private fun received(s: ActivityScenario<MainActivity>): List<String> {
        val raw = JSONTokener(js(s, "JSON.stringify(window.received.map(m => m.type + (m.state ? ':' + m.state : '')))")).nextValue()
        val list = JSONArray(raw as String)
        return (0 until list.length()).map { list.getString(it) }
    }

    @Test fun aLaunchLinkOpensItsPage() {
        val s = launch("$TEST/bridge.html")
        waitFor(s, "document.title", "\"bridge\"")
    }

    @Test fun theBridgeIsThereForTheAppsSiteAndNotForAFrameFromAnywhereElse() {
        val s = launch("$TEST/bridge.html")
        waitFor(s, "typeof window.SpatialNativeHost", "\"object\"")
        // A frame of another origin (srcdoc's is opaque) gets no bridge.
        waitFor(s, "window.frameSeesHost", "\"undefined\"")
    }

    @Test fun startAnswersWithHelloAndOnAPhoneWithoutArcoreSaysWhyItFailed() {
        val s = launch("$TEST/bridge.html")
        waitFor(s, "typeof window.SpatialNativeHost", "\"object\"")
        js(s, "window.send({type: 'start'})")
        waitFor(s, "window.received.length >= 2", "true")
        assertEquals(listOf("hello", "session:failed"), received(s).take(2))
        assertEquals("\"android\"", js(s, "window.received[0].platform"))
        assertEquals("1", js(s, "window.received[0].version"))
        // The reason reaches the page, so it can say it and fall back.
        assertTrue(js(s, "window.received[1].reason").contains("ARCore"))
    }

    @Test fun malformedMessagesAreIgnoredAndTheBridgeKeepsWorking() {
        val s = launch("$TEST/bridge.html")
        waitFor(s, "typeof window.SpatialNativeHost", "\"object\"")
        for (junk in listOf("'nonsense'", "'{\"type\":\"launch\"}'", "'{\"type\":\"request-image\"}'", "'{'")) js(s, "window.send($junk)")
        Thread.sleep(500)
        assertEquals(emptyList<String>(), received(s))
        js(s, "window.send({type: 'start'})")
        waitFor(s, "window.received.length >= 1", "true")
        assertEquals("hello", received(s).first())
    }

    @Test fun aLinkToAnotherSiteOpensInTheBrowserNotInTheApp() {
        val s = launch("$TEST/bridge.html")
        waitFor(s, "document.title", "\"bridge\"")
        // Recorded and stubbed from here on, so the launch itself is not.
        Intents.init()
        try {
            intending(hasAction(Intent.ACTION_VIEW)).respondWith(Instrumentation.ActivityResult(Activity.RESULT_OK, null))
            js(s, "document.getElementById('away').click()")
            Thread.sleep(1000)
            intended(allOf(hasAction(Intent.ACTION_VIEW), hasData("https://example.com/")))
            // And the page with the bridge is still the one loaded.
            assertEquals("\"bridge\"", js(s, "document.title"))
        } finally {
            Intents.release()
        }
    }

    @Test fun aLaunchLinkToAnotherSiteOpensHomeInsteadAndNeverThatSite() {
        val s = launch("https://evil.example/")
        // Home is the real site, which needs network the emulator may not have:
        // what matters is that the other site was never loaded.
        Thread.sleep(1500)
        val url = js(s, "location.href")
        assertTrue("loaded $url", !url.contains("evil.example"))
    }

    @Test fun aSecondLinkWhileRunningOpensItsPageInTheSameApp() {
        val s = launch("$TEST/bridge.html")
        waitFor(s, "document.title", "\"bridge\"")
        val link = "spatialar://open?url=" + URLEncoder.encode("$TEST/second.html", "UTF-8")
        // As Android delivers it: the running activity (singleTask) gets the new intent.
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        context.startActivity(
            Intent(Intent.ACTION_VIEW, Uri.parse(link)).setClass(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
        waitFor(s, "document.title", "\"second\"")
    }

    private companion object {
        const val TEST = "https://appassets.androidplatform.net/assets"
    }
}
