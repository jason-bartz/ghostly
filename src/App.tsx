import { useEffect, useState, useRef } from "react";
import { toast, Toaster } from "sonner";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { platform } from "@tauri-apps/plugin-os";
import {
  checkAccessibilityPermission,
  checkMicrophonePermission,
} from "tauri-plugin-macos-permissions-api";
import { ModelStateEvent, RecordingErrorEvent } from "./lib/types/events";
import "./App.css";
import AccessibilityPermissions from "./components/AccessibilityPermissions";
import { EulaGate } from "./components/EulaGate";
import Footer from "./components/footer";
import { Tour, type TourMode } from "./components/onboarding";
import { Sidebar, SidebarSection, SECTIONS_CONFIG } from "./components/Sidebar";
import { UpdateModal } from "./components/update-checker";
import { useSettings } from "./hooks/useSettings";
import { useSettingsStore } from "./stores/settingsStore";
import { useUpdaterStore } from "./stores/updaterStore";
import { commands } from "@/bindings";
import { getLanguageDirection, initializeRTL } from "@/lib/utils/rtl";
import { useAppearanceSync } from "./hooks/useAppearance";

/** `null` while we're still resolving; a mode means the tour is on screen. */
type TourState = TourMode | "done" | null;

const renderSettingsContent = (section: SidebarSection) => {
  const ActiveComponent =
    SECTIONS_CONFIG[section]?.component || SECTIONS_CONFIG.general.component;
  // Keying on the section re-fires the mount animation on every navigation, so
  // switching panes reads as a transition rather than a hard swap. `w-full`
  // preserves each pane's own `max-w-*` centring.
  return (
    <div key={section} className="w-full animate-rise">
      <ActiveComponent />
    </div>
  );
};

function App() {
  const { t, i18n } = useTranslation();
  const [tourState, setTourState] = useState<TourState>(null);
  // null = still resolving, true = gate active, false = accepted (or skipped)
  const [eulaRequired, setEulaRequired] = useState<boolean | null>(null);
  const [currentSection, setCurrentSection] =
    useState<SidebarSection>("history");
  const { settings, updateSetting } = useSettings();
  // Keeps <html data-theme> in step with the saved preference (and the OS,
  // when the preference is "system"). Every colour token keys off it.
  useAppearanceSync();
  const direction = getLanguageDirection(i18n.language);
  const refreshAudioDevices = useSettingsStore(
    (state) => state.refreshAudioDevices,
  );
  const refreshOutputDevices = useSettingsStore(
    (state) => state.refreshOutputDevices,
  );
  const hasCompletedPostOnboardingInit = useRef(false);

  useEffect(() => {
    checkOnboardingStatus();
  }, []);

  // Cross-component navigation: any settings component can fire
  // `ghostly:navigate` to jump to another sidebar section.
  useEffect(() => {
    const onNavigate = (e: Event) => {
      const section = (e as CustomEvent<{ section?: string }>).detail?.section;
      if (!section) return;
      if (section in SECTIONS_CONFIG) {
        setCurrentSection(section as SidebarSection);
      }
    };
    window.addEventListener("ghostly:navigate", onNavigate);
    return () => window.removeEventListener("ghostly:navigate", onNavigate);
  }, []);

  // Resolve EULA gate state on mount. Show the gate if the accepted version
  // on disk doesn't match the current EULA version shipped in this build.
  useEffect(() => {
    (async () => {
      try {
        const [settingsRes, eulaRes] = await Promise.all([
          commands.getAppSettings(),
          commands.getEula(),
        ]);
        if (settingsRes.status !== "ok" || eulaRes.status !== "ok") {
          setEulaRequired(true);
          return;
        }
        const accepted = settingsRes.data.eula_accepted_version;
        const current = eulaRes.data[1];
        setEulaRequired(accepted !== current);
      } catch {
        setEulaRequired(true);
      }
    })();
  }, []);

  // Initialize RTL direction when language changes
  useEffect(() => {
    initializeRTL(i18n.language);
  }, [i18n.language]);

  // Initialize Enigo, shortcuts, and refresh audio devices when main app loads
  useEffect(() => {
    if (tourState === "done" && !hasCompletedPostOnboardingInit.current) {
      hasCompletedPostOnboardingInit.current = true;
      Promise.all([
        commands.initializeEnigo(),
        commands.initializeShortcuts(),
      ]).catch((e) => {
        console.warn("Failed to initialize:", e);
      });
      refreshAudioDevices();
      refreshOutputDevices();

      // Silent update check on launch. Auto-opens the update modal once
      // per new version (tracked in localStorage); otherwise only the
      // footer indicator reflects the available update.
      const checkForUpdates = useUpdaterStore.getState().check;
      const timer = window.setTimeout(() => {
        void checkForUpdates({ silent: true });
      }, 2500);
      return () => window.clearTimeout(timer);
    }
  }, [tourState, refreshAudioDevices, refreshOutputDevices]);

  // Replaying the tour from Settings → App. Everything it teaches is still
  // true after first run, and the features it surfaces are the ones people
  // never find on their own.
  useEffect(() => {
    const onReplay = () => setTourState("replay");
    window.addEventListener("ghostly:replay-tour", onReplay);
    return () => window.removeEventListener("ghostly:replay-tour", onReplay);
  }, []);

  // Handle keyboard shortcuts for debug mode toggle
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Check for Ctrl+Shift+D (Windows/Linux) or Cmd+Shift+D (macOS)
      const isDebugShortcut =
        event.shiftKey &&
        event.key.toLowerCase() === "d" &&
        (event.ctrlKey || event.metaKey);

      if (isDebugShortcut) {
        event.preventDefault();
        const currentDebugMode = settings?.debug_mode ?? false;
        updateSetting("debug_mode", !currentDebugMode);
      }
    };

    // Add event listener when component mounts
    document.addEventListener("keydown", handleKeyDown);

    // Cleanup event listener when component unmounts
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [settings?.debug_mode, updateSetting]);

  // Listen for recording errors from the backend and show a toast
  useEffect(() => {
    const unlisten = listen<RecordingErrorEvent>("recording-error", (event) => {
      const { error_type, detail } = event.payload;

      if (error_type === "microphone_permission_denied") {
        const currentPlatform = platform();
        const platformKey = `errors.micPermissionDenied.${currentPlatform}`;
        const description = t(platformKey, {
          defaultValue: t("errors.micPermissionDenied.generic"),
        });
        toast.error(t("errors.micPermissionDeniedTitle"), { description });
      } else if (error_type === "no_input_device") {
        toast.error(t("errors.noInputDeviceTitle"), {
          description: t("errors.noInputDevice"),
        });
      } else {
        toast.error(
          t("errors.recordingFailed", { error: detail ?? "Unknown error" }),
        );
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [t]);

  // Listen for paste failures and show a toast.
  // The technical error detail is logged to ghostly.log on the Rust side
  // (see actions.rs `error!("Failed to paste transcription: ...")`),
  // so we show a localized, user-friendly message here instead of the raw error.
  useEffect(() => {
    const unlisten = listen("paste-error", () => {
      toast.error(t("errors.pasteFailedTitle"), {
        description: t("errors.pasteFailed"),
      });
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [t]);

  // Listen for AI refinement failures so users aren't left guessing when the
  // raw transcript appears instead of the refined version. The Rust side emits
  // a concise reason; full stack traces are in ghostly.log.
  useEffect(() => {
    const unlisten = listen<{ message: string }>(
      "post-process-failed",
      (event) => {
        toast.error(t("errors.postProcessFailedTitle"), {
          description: event.payload.message,
        });
      },
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [t]);

  // Listen for Screenshot Q&A failures so the user sees what went wrong
  // (missing permission, no vision provider, bad API key, etc.).
  useEffect(() => {
    const unlisten = listen<{ message: string }>(
      "screenshot-qa-failed",
      (event) => {
        toast.error(t("errors.screenshotQaFailedTitle"), {
          description: event.payload.message,
        });
      },
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [t]);

  // Navigate to the License settings pane when the paywall's "I have a key"
  // button is clicked, or when an auto-activate deep link arrives.
  useEffect(() => {
    const onNav = () => setCurrentSection("account");
    window.addEventListener("ghostly-navigate-to-license", onNav);
    const unlistenAuto = listen("license-auto-activate", () => {
      setCurrentSection("account");
    });
    return () => {
      window.removeEventListener("ghostly-navigate-to-license", onNav);
      void unlistenAuto.then((fn) => fn());
    };
  }, []);

  // Soft warning when free-tier users cross 80% of their weekly cap. Emitted
  // once per week by the backend, so a single toast is enough.
  useEffect(() => {
    const unlisten = listen("usage-warning", () => {
      toast.warning(t("usage.warningToast.title"), {
        description: t("usage.warningToast.description"),
      });
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [t]);

  // Listen for model loading failures and show a toast
  useEffect(() => {
    const unlisten = listen<ModelStateEvent>("model-state-changed", (event) => {
      if (event.payload.event_type === "loading_failed") {
        toast.error(
          t("errors.modelLoadFailed", {
            model:
              event.payload.model_name || t("errors.modelLoadFailedUnknown"),
          }),
          {
            description: event.payload.error,
          },
        );
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [t]);

  const revealMainWindowForPermissions = async () => {
    try {
      await commands.showMainWindowCommand();
    } catch (e) {
      console.warn("Failed to show main window for permission onboarding:", e);
    }
  };

  const checkOnboardingStatus = async () => {
    try {
      // A starter model ships inside the app bundle, so "has any model" is no
      // longer a valid proxy for "has been set up" — every install has one from
      // first launch. The backend flag is the authority (and migrates existing
      // users forward so an upgrade never re-runs onboarding).
      const result = await commands.needsOnboarding();
      const isNewUser = result.status === "ok" ? result.data : false;

      if (isNewUser) {
        setTourState("first-run");
        return;
      }

      // Returning user — the only thing that can still block them is a
      // permission that was revoked (or never granted after a skip).
      if (platform() === "macos") {
        try {
          const [hasAccessibility, hasMicrophone] = await Promise.all([
            checkAccessibilityPermission(),
            checkMicrophonePermission(),
          ]);
          if (!hasAccessibility || !hasMicrophone) {
            await revealMainWindowForPermissions();
            setTourState("permissions");
            return;
          }
        } catch (e) {
          console.warn("Failed to check macOS permissions:", e);
          // If we can't check, proceed to main app and let them fix it there
        }
      }

      setTourState("done");
    } catch (error) {
      console.error("Failed to check onboarding status:", error);
      setTourState("first-run");
    }
  };

  // Still resolving either check
  if (tourState === null || eulaRequired === null) {
    return null;
  }

  // Block on EULA before any onboarding or main UI
  if (eulaRequired) {
    return <EulaGate onAccepted={() => setEulaRequired(false)} />;
  }

  if (tourState !== "done") {
    return (
      <Tour
        key={tourState}
        mode={tourState}
        onComplete={() => setTourState("done")}
      />
    );
  }

  return (
    <div
      dir={direction}
      className="app-canvas h-screen flex flex-col select-none cursor-default"
    >
      <Toaster
        // Sonner's own theming is bypassed (`unstyled`), and the toast surface
        // is painted from the `--color-*` tokens in App.css — which already
        // follow the app theme. Pinning "dark" here only desynced the few
        // styles Sonner still owns when the app was in light mode.
        theme="system"
        toastOptions={{
          unstyled: true,
          classNames: {
            toast:
              "glass-raised rounded-xl px-4 py-3 flex items-center gap-3 text-sm text-text",
            title: "font-medium text-text",
            description: "text-text-muted",
          },
        }}
      />
      {/* Main content area that takes remaining space */}
      <div className="flex-1 flex overflow-hidden">
        <Sidebar
          activeSection={currentSection}
          onSectionChange={setCurrentSection}
        />
        {/* Scrollable content area */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto">
            <div className="flex flex-col items-center p-4 gap-4">
              <AccessibilityPermissions />
              {renderSettingsContent(currentSection)}
            </div>
          </div>
        </div>
      </div>
      {/* Fixed footer at bottom */}
      <Footer />
      <UpdateModal />
    </div>
  );
}

export default App;
