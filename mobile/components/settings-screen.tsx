/** Renders native appearance and AI settings against the shared Blitz contracts. */

import AsyncStorage from "@react-native-async-storage/async-storage"
import { useCallback, useEffect, useState, type ReactNode } from "react"
import {
  ActivityIndicator,
  Appearance,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"

import {
  AI_PROVIDER_APPROVAL_POLICIES,
  AI_PROVIDER_MODEL_OPTIONS,
  AI_PROVIDER_OPTIONS,
  AI_REASONING_EFFORTS,
  CODEX_MODEL_OPTIONS,
  DEFAULT_AI_MODEL_SETTINGS,
  getAiProviderOptionsForTask,
  resolveProviderApprovalPolicy,
  type AiApprovalPolicy,
  type AiModelSettings,
  type AiProviderId,
  type AiReasoningEffort,
} from "../../lib/ai-model-settings"
import {
  AccountApiError,
  changeProviderConnection,
  fetchProviderAvailability,
  fetchSettings,
  saveSettings,
  type MobileProviderAvailability,
} from "../lib/account-api"
import { Text } from "./native-text"
import {
  WebArrowLeftIcon,
  WebArrowRightIcon,
  WebCheckIcon,
  WebRefreshIcon,
} from "./web-icon"

/** Props for the isolated native settings screen. */
export type SettingsScreenProps = {
  readonly serverUrl: string
  readonly onClose?: () => void
}
type ThemeChoice = "system" | "light" | "dark"
type AccentChoice =
  "red" | "orange" | "yellow" | "green" | "blue" | "indigo" | "violet"

const THEME_KEY = "blitz-mobile-theme-v1"
const ACCENT_KEY = "blitz-mobile-accent-v1"
const ACCENTS: readonly { id: AccentChoice; label: string; color: string }[] = [
  { id: "red", label: "Red", color: "#ef4444" },
  { id: "orange", label: "Orange", color: "#f97316" },
  { id: "yellow", label: "Yellow", color: "#eab308" },
  { id: "green", label: "Green", color: "#22c55e" },
  { id: "blue", label: "Blue", color: "#3b82f6" },
  { id: "indigo", label: "Indigo", color: "#6366f1" },
  { id: "violet", label: "Violet", color: "#8b5cf6" },
]
const TASKS = [
  {
    task: "research",
    key: "researchProvider",
    model: "researchModel",
    effort: "researchEffort",
    label: "Research",
    description: "Plans research and looks for sources to learn from.",
  },
  {
    task: "cardGeneration",
    key: "cardGenerationProvider",
    model: "cardGenerationModel",
    effort: "cardGenerationEffort",
    label: "Card generation",
    description: "Turns uploaded source material into study cards.",
  },
  {
    task: "reply",
    key: "replyProvider",
    model: "replyModel",
    effort: "replyEffort",
    label: "Replies",
    description: "Answers questions in workspace chat and about study cards.",
  },
] as const

/** Returns the web-aligned connection badge text for one provider state. */
function connectionLabel(provider: MobileProviderAvailability): string {
  if (!provider.available) return "Not installed"
  if (provider.authenticated === true) return "Connected"
  if (provider.authenticated === false) return "Needs sign in"
  return "Check required"
}

/** Returns the provider setup control label for one available runtime. */
function connectionActionLabel(
  provider: MobileProviderAvailability,
  busy: boolean
): string {
  if (!provider.available && provider.providerId === "antigravity")
    return busy ? "Installing…" : "Install and connect"
  if (provider.authenticated === true)
    return busy ? "Disconnecting…" : "Disconnect"
  return busy ? "Connecting…" : "Connect"
}

/** Returns the compact access label used by the web settings controls. */
function accessLabel(provider: AiProviderId, policy: AiApprovalPolicy): string {
  const labels: Record<
    AiProviderId,
    Partial<Record<AiApprovalPolicy, string>>
  > = {
    codex: {
      "on-request": "Ask for approval",
      untrusted: "Ask for untrusted commands",
      never: "Never approve",
      "full-access": "Full access",
    },
    "claude-code": {
      never: "Tools disabled",
      "on-request": "Ask permissions",
      "full-access": "Bypass permissions",
    },
    opencode: {
      never: "Deny tools",
      "on-request": "Ask",
      "full-access": "Allow",
    },
    antigravity: { "on-request": "Default", "full-access": "YOLO" },
  }
  return labels[provider][policy] ?? policy
}

/** Returns the display label for a reasoning effort. */
function effortLabel(value: AiReasoningEffort): string {
  return value === "default"
    ? "Default"
    : value === "xhigh"
      ? "Extra high"
      : `${value[0].toUpperCase()}${value.slice(1)}`
}

/** Returns the configured model choices for a provider, including runtime models. */
function modelsFor(
  provider: AiProviderId,
  runtime: MobileProviderAvailability[]
): readonly {
  id: string
  label: string
  reasoningEfforts: readonly AiReasoningEffort[]
}[] {
  const live = runtime.find((item) => item.providerId === provider)?.models
  if (live?.length)
    return live.map((model) => ({
      id: model.id,
      label: model.label,
      reasoningEfforts: (model.reasoningEfforts?.length
        ? model.reasoningEfforts
        : ["default"]) as readonly AiReasoningEffort[],
    }))
  if (provider === "codex") return CODEX_MODEL_OPTIONS
  return AI_PROVIDER_MODEL_OPTIONS[provider]
}

/** Reads a bounded local preference with a fallback. */
async function localPreference<T extends string>(
  key: string,
  fallback: T,
  valid: readonly T[]
): Promise<T> {
  const value = await AsyncStorage.getItem(key)
  return value && valid.includes(value as T) ? (value as T) : fallback
}

/** Renders appearance controls and a complete server-backed AI settings editor. */
export function SettingsScreen({ serverUrl, onClose }: SettingsScreenProps) {
  const insets = useSafeAreaInsets()
  const systemScheme = Appearance.getColorScheme()
  const [theme, setTheme] = useState<ThemeChoice>("system")
  const [accent, setAccent] = useState<AccentChoice>("orange")
  const [settings, setSettings] = useState<AiModelSettings>({
    ...DEFAULT_AI_MODEL_SETTINGS,
  })
  const [providers, setProviders] = useState<MobileProviderAvailability[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [feedback, setFeedback] = useState("")
  const [connectionBusy, setConnectionBusy] = useState<AiProviderId>()
  const [connectionFeedback, setConnectionFeedback] = useState("")
  const [selectedMethods, setSelectedMethods] = useState<
    Partial<Record<AiProviderId, string>>
  >({})
  const [selectedAccounts, setSelectedAccounts] = useState<
    Partial<Record<AiProviderId, string>>
  >({})

  const isDark =
    theme === "dark" || (theme === "system" && systemScheme !== "light")
  const colors = isDark ? darkColors : lightColors
  const activeAccent =
    ACCENTS.find((item) => item.id === accent)?.color ?? "#f97316"

  /** Loads local appearance preferences and server settings together. */
  const load = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const [nextTheme, nextAccent, nextSettings, nextProviders] =
        await Promise.all([
          localPreference(THEME_KEY, "system", ["system", "light", "dark"]),
          localPreference(
            ACCENT_KEY,
            "orange",
            ACCENTS.map((item) => item.id)
          ),
          fetchSettings(serverUrl),
          fetchProviderAvailability(serverUrl),
        ])
      setTheme(nextTheme)
      setAccent(nextAccent)
      setSettings({ ...DEFAULT_AI_MODEL_SETTINGS, ...(nextSettings ?? {}) })
      setProviders(nextProviders)
      setSelectedMethods((current) => {
        const next = { ...current }
        nextProviders.forEach((provider) => {
          const method = provider.authMethods?.[0]?.id
          if (!next[provider.providerId] && method)
            next[provider.providerId] = method
        })
        return next
      })
      setSelectedAccounts((current) => {
        const next = { ...current }
        nextProviders.forEach((provider) => {
          const account = provider.accounts?.[0]
          if (!next[provider.providerId] && account)
            next[provider.providerId] = account
        })
        return next
      })
    } catch (value) {
      setError(
        value instanceof AccountApiError
          ? value.message
          : "Could not load settings"
      )
    } finally {
      setLoading(false)
    }
  }, [serverUrl])

  useEffect(() => {
    void load()
  }, [load])

  /** Applies and persists the native equivalent of the web theme preference. */
  async function chooseTheme(next: ThemeChoice): Promise<void> {
    setTheme(next)
    // Expo's runtime accepts null to clear an explicit override; its SDK 57
    // declaration omits that documented reset value.
    Appearance.setColorScheme(
      (next === "system" ? null : next) as "light" | "dark"
    )
    await AsyncStorage.setItem(THEME_KEY, next)
  }

  /** Persists the native accent selection for the next screen mount. */
  async function chooseAccent(next: AccentChoice): Promise<void> {
    setAccent(next)
    await AsyncStorage.setItem(ACCENT_KEY, next)
  }

  /** Updates one task's provider, model, and reasoning while keeping values compatible. */
  function updateTask(
    task: (typeof TASKS)[number],
    field: string,
    value: string
  ): void {
    setSettings((current) => {
      const next = { ...current, [field]: value } as AiModelSettings
      if (field === task.key) {
        const options = modelsFor(value as AiProviderId, providers)
        next[task.model] = options[0]?.id ?? next[task.model]
        next[task.effort] = options[0]?.reasoningEfforts[0] ?? "default"
      }
      return next
    })
  }

  /** Cycles a provider's interactive sign-in method when several are available. */
  function cycleProviderMethod(provider: MobileProviderAvailability): void {
    const methods = provider.authMethods ?? []
    if (!methods.length) return
    const current = selectedMethods[provider.providerId] ?? methods[0].id
    const index = methods.findIndex((method) => method.id === current)
    setSelectedMethods((value) => ({
      ...value,
      [provider.providerId]: methods[(index + 1) % methods.length].id,
    }))
  }

  /** Cycles the selected disconnectable account without exposing credentials. */
  function cycleProviderAccount(provider: MobileProviderAvailability): void {
    const accounts = provider.accounts ?? []
    if (!accounts.length) return
    const current = selectedAccounts[provider.providerId] ?? accounts[0]
    const index = accounts.findIndex((account) => account === current)
    setSelectedAccounts((value) => ({
      ...value,
      [provider.providerId]: accounts[(index + 1) % accounts.length],
    }))
  }

  /** Cycles a picker value through its safe, visible options. */
  function cycle(
    task: (typeof TASKS)[number],
    field: "provider" | "model" | "effort"
  ): void {
    const provider = settings[task.key] ?? "codex"
    if (field === "provider") {
      const choices = getAiProviderOptionsForTask(task.task)
      const index = choices.findIndex((item) => item.id === provider)
      updateTask(task, task.key, choices[(index + 1) % choices.length].id)
      return
    }
    if (field === "model") {
      const choices = modelsFor(provider, providers)
      const index = choices.findIndex(
        (item) => item.id === settings[task.model]
      )
      updateTask(task, task.model, choices[(index + 1) % choices.length].id)
      return
    }
    if (field === "effort") {
      const choices =
        modelsFor(provider, providers).find(
          (item) => item.id === settings[task.model]
        )?.reasoningEfforts ?? AI_REASONING_EFFORTS
      const index = choices.indexOf(settings[task.effort])
      updateTask(
        task,
        task.effort,
        choices[(index + 1) % choices.length] ?? "default"
      )
      return
    }
  }

  /** Cycles one provider's persisted approval policy across its supported choices. */
  function cycleProviderPolicy(provider: AiProviderId): void {
    const choices = AI_PROVIDER_APPROVAL_POLICIES[provider]
    const current = settings.providerApprovalPolicies?.[provider] ?? choices[0]
    const index = choices.indexOf(current)
    setSettings((value) => ({
      ...value,
      providerApprovalPolicies: {
        ...value.providerApprovalPolicies,
        [provider]: choices[(index + 1) % choices.length],
      },
    }))
  }

  /** Sends a provider connection action to the server and refreshes its status. */
  async function changeConnection(
    provider: MobileProviderAvailability,
    action: "connect" | "disconnect" | "install"
  ): Promise<void> {
    if (connectionBusy) return
    setConnectionBusy(provider.providerId)
    setConnectionFeedback("")
    try {
      await changeProviderConnection(serverUrl, {
        providerId: provider.providerId,
        action,
        ...(selectedMethods[provider.providerId]
          ? { methodId: selectedMethods[provider.providerId] }
          : {}),
        ...(selectedAccounts[provider.providerId]
          ? { account: selectedAccounts[provider.providerId] }
          : {}),
      })
      const nextProviders = await fetchProviderAvailability(serverUrl)
      setProviders(nextProviders)
      setConnectionFeedback(
        action === "install"
          ? "Provider installed and connected."
          : action === "connect"
            ? "Provider connection updated."
            : "Provider disconnected."
      )
    } catch (value) {
      setConnectionFeedback(
        value instanceof AccountApiError
          ? value.message
          : "The provider could not complete the request."
      )
    } finally {
      setConnectionBusy(undefined)
    }
  }

  /** Confirms a provider disconnect before clearing local credentials. */
  function confirmDisconnect(provider: MobileProviderAvailability): void {
    Alert.alert(
      `Disconnect ${provider.providerId}`,
      "This clears the provider's local credentials. Blitz cannot use it until you connect again.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Disconnect",
          style: "destructive",
          onPress: () => void changeConnection(provider, "disconnect"),
        },
      ]
    )
  }

  /** Saves the complete AI configuration and reports the result inline. */
  async function save(): Promise<void> {
    setSaving(true)
    setFeedback("")
    setError("")
    try {
      for (const task of TASKS) {
        const providerId = settings[task.key] ?? "codex"
        const provider = providers.find(
          (item) => item.providerId === providerId
        )
        if (!provider?.available || provider.authenticated === false)
          throw new Error(
            provider?.message ?? "Could not check provider setup."
          )
      }
      const saved = await saveSettings(serverUrl, settings)
      setSettings(saved)
      setFeedback("Settings saved")
    } catch (value) {
      setError(
        value instanceof AccountApiError
          ? value.message
          : "Settings could not be saved"
      )
    } finally {
      setSaving(false)
    }
  }

  if (loading)
    return (
      <View
        style={[
          styles.centered,
          { backgroundColor: colors.background, paddingBottom: insets.bottom },
        ]}
      >
        <ActivityIndicator color="#ff8065" />
        <Text style={[styles.body, { color: colors.muted }]}>
          Loading settings
        </Text>
      </View>
    )
  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <View
        style={[
          styles.header,
          {
            borderBottomColor: colors.border,
            paddingTop: Math.max(insets.top, 12) + 12,
          },
        ]}
      >
        {onClose ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close settings"
            onPress={onClose}
          >
            <WebArrowLeftIcon
              size={21}
              color={colors.foreground}
              strokeWidth={1.8}
            />
          </Pressable>
        ) : (
          <View />
        )}
        <Text style={[styles.title, { color: colors.foreground }]}>
          Settings
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Reload settings"
          onPress={() => void load()}
        >
          <WebRefreshIcon size={22} color={colors.muted} strokeWidth={1.8} />
        </Pressable>
      </View>
      <ScrollView
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 16) + 76,
          paddingHorizontal: 16,
          paddingTop: 24,
        }}
      >
        <Text style={[styles.intro, { color: colors.muted }]}>
          Customize how Blitz looks and choose the models behind your study
          tools.
        </Text>
        <Text style={[styles.sectionTitle, { color: colors.foreground }]}>
          Appearance
        </Text>
        <Text style={[styles.sectionHint, { color: colors.muted }]}>
          Choose the theme and accent colour for Blitz.
        </Text>
        <View
          style={[
            styles.card,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          <SettingRow
            label="Theme"
            description="Use your device setting or choose light or dark mode."
            colors={colors}
          >
            <View style={styles.choiceRow}>
              {(["system", "light", "dark"] as const).map((value) => (
                <Choice
                  key={value}
                  label={value[0].toUpperCase() + value.slice(1)}
                  selected={theme === value}
                  onPress={() => void chooseTheme(value)}
                  colors={colors}
                  accent={activeAccent}
                />
              ))}
            </View>
          </SettingRow>
          <SettingRow
            label="Accent colour"
            description="Pick the colour used for active controls and key actions."
            colors={colors}
          >
            <View style={styles.accentRow}>
              {ACCENTS.map((item) => (
                <Pressable
                  key={item.id}
                  accessibilityRole="button"
                  accessibilityLabel={`${item.label} accent colour`}
                  accessibilityState={{ selected: accent === item.id }}
                  onPress={() => void chooseAccent(item.id)}
                  style={[
                    styles.swatch,
                    { backgroundColor: item.color },
                    accent === item.id && styles.selectedSwatch,
                  ]}
                >
                  {accent === item.id ? (
                    <WebCheckIcon size={17} color="#ffffff" strokeWidth={2} />
                  ) : null}
                </Pressable>
              ))}
            </View>
          </SettingRow>
        </View>
        <View style={styles.sectionHeadingRow}>
          <View style={styles.sectionHeadingCopy}>
            <Text style={[styles.sectionTitle, { color: colors.foreground }]}>
              Provider connections
            </Text>
            <Text style={[styles.sectionHint, { color: colors.muted }]}>
              Check the local runtimes and manage their sign-in state.
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Check provider connections again"
            disabled={loading || connectionBusy !== undefined}
            onPress={() => void load()}
            style={styles.checkButton}
          >
            <Text style={[styles.checkButtonText, { color: activeAccent }]}>
              Check again
            </Text>
          </Pressable>
        </View>
        <View
          style={[
            styles.card,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          {AI_PROVIDER_OPTIONS.map((option) => {
            const provider = providers.find(
              (item) => item.providerId === option.id
            )
            if (!provider) return null
            const busy = connectionBusy === provider.providerId
            const action =
              !provider.available && provider.providerId === "antigravity"
                ? "install"
                : provider.authenticated === true
                  ? "disconnect"
                  : "connect"
            const methods = provider.authMethods ?? []
            const accounts = provider.accounts ?? []
            const selectedMethod =
              methods.find(
                (method) => method.id === selectedMethods[provider.providerId]
              ) ?? methods[0]
            const selectedAccount =
              selectedAccounts[provider.providerId] ?? accounts[0]
            return (
              <View
                key={provider.providerId}
                style={[
                  styles.providerRow,
                  { borderBottomColor: colors.border },
                ]}
              >
                <View style={styles.providerCopy}>
                  <View style={styles.providerHeading}>
                    <Text
                      style={[
                        styles.providerName,
                        { color: colors.foreground },
                      ]}
                    >
                      {option.label}
                    </Text>
                    <Text
                      style={[
                        styles.providerStatus,
                        {
                          color:
                            provider.authenticated === true
                              ? "#4ade80"
                              : provider.available
                                ? "#ffb17f"
                                : colors.muted,
                        },
                      ]}
                    >
                      {connectionLabel(provider)}
                    </Text>
                  </View>
                  <Text
                    style={[styles.providerMessage, { color: colors.muted }]}
                  >
                    {provider.message}
                  </Text>
                  {provider.providerId === "antigravity" ? (
                    <Text
                      style={[styles.providerNote, { color: colors.muted }]}
                    >
                      Antigravity ACP has its own account and does not use the
                      desktop app sign-in.
                    </Text>
                  ) : null}
                </View>
                <View style={styles.providerActions}>
                  {methods.length > 1 ? (
                    <PickerButton
                      label="Sign in"
                      value={selectedMethod?.name ?? "Choose method"}
                      onPress={() => cycleProviderMethod(provider)}
                      colors={colors}
                    />
                  ) : null}
                  {provider.authenticated === true && accounts.length > 1 ? (
                    <PickerButton
                      label="Account"
                      value={selectedAccount ?? "Choose account"}
                      onPress={() => cycleProviderAccount(provider)}
                      colors={colors}
                    />
                  ) : null}
                  {(provider.available && provider.authenticated !== true) ||
                  (!provider.available &&
                    provider.providerId === "antigravity") ? (
                    <Pressable
                      accessibilityRole="button"
                      disabled={
                        busy || (action === "connect" && methods.length === 0)
                      }
                      onPress={() => void changeConnection(provider, action)}
                      style={[
                        styles.providerButton,
                        { backgroundColor: activeAccent },
                        busy && styles.disabled,
                      ]}
                    >
                      <Text style={styles.providerButtonText}>
                        {connectionActionLabel(provider, busy)}
                      </Text>
                    </Pressable>
                  ) : null}
                  {provider.available &&
                  provider.authenticated === true &&
                  provider.canDisconnect ? (
                    <Pressable
                      accessibilityRole="button"
                      disabled={busy}
                      onPress={() => confirmDisconnect(provider)}
                      style={[styles.providerButton, styles.outlineButton]}
                    >
                      <Text
                        style={[
                          styles.providerButtonText,
                          { color: colors.foreground },
                        ]}
                      >
                        {connectionActionLabel(provider, busy)}
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
              </View>
            )
          })}
          <Text style={[styles.providerFooter, { color: colors.muted }]}>
            Connections stay on this device and are managed by each provider.
          </Text>
          {connectionFeedback ? (
            <Text accessibilityRole="alert" style={styles.connectionFeedback}>
              {connectionFeedback}
            </Text>
          ) : null}
        </View>
        <Text
          style={[
            styles.sectionTitle,
            { color: colors.foreground, marginTop: 28 },
          ]}
        >
          AI settings
        </Text>
        <Text style={[styles.sectionHint, { color: colors.muted }]}>
          Choose the provider, model, and reasoning level for each task.
        </Text>
        <View
          style={[
            styles.card,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          {TASKS.map((task) => (
            <View
              key={task.key}
              style={[styles.task, { borderBottomColor: colors.border }]}
            >
              <Text style={[styles.taskLabel, { color: colors.foreground }]}>
                {task.label}
              </Text>
              <Text style={[styles.taskDescription, { color: colors.muted }]}>
                {task.description}
              </Text>
              <PickerButton
                label="Provider"
                value={
                  AI_PROVIDER_OPTIONS.find(
                    (item) => item.id === (settings[task.key] ?? "codex")
                  )?.label ?? "Codex"
                }
                onPress={() => cycle(task, "provider")}
                colors={colors}
              />
              <PickerButton
                label="Model"
                value={
                  modelsFor(settings[task.key] ?? "codex", providers).find(
                    (item) => item.id === settings[task.model]
                  )?.label ?? settings[task.model]
                }
                onPress={() => cycle(task, "model")}
                colors={colors}
              />
              <PickerButton
                label="Reasoning"
                value={effortLabel(settings[task.effort])}
                onPress={() => cycle(task, "effort")}
                colors={colors}
              />
            </View>
          ))}
          <View
            style={[styles.accessSection, { borderTopColor: colors.border }]}
          >
            <Text style={[styles.taskLabel, { color: colors.foreground }]}>
              Provider access
            </Text>
            <Text style={[styles.taskDescription, { color: colors.muted }]}>
              Applies when chat uses Provider policy. Background tasks always
              use restricted policies.
            </Text>
            {AI_PROVIDER_OPTIONS.map((provider) => {
              const policy = resolveProviderApprovalPolicy(
                settings,
                provider.id
              )
              return (
                <View key={provider.id} style={styles.accessRow}>
                  <View style={styles.accessCopy}>
                    <Text
                      style={[styles.accessLabel, { color: colors.foreground }]}
                    >
                      {provider.label}
                    </Text>
                    {provider.id === "antigravity" ? (
                      <Text
                        style={[
                          styles.accessDescription,
                          { color: colors.muted },
                        ]}
                      >
                        Workspace chat only.
                      </Text>
                    ) : null}
                  </View>
                  <PickerButton
                    label="Access"
                    value={accessLabel(provider.id, policy)}
                    onPress={() => cycleProviderPolicy(provider.id)}
                    colors={colors}
                  />
                </View>
              )
            })}
          </View>
        </View>
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}
        {feedback ? <Text style={styles.success}>{feedback}</Text> : null}
        <Pressable
          accessibilityRole="button"
          disabled={saving}
          onPress={() => void save()}
          style={[
            styles.save,
            { backgroundColor: activeAccent },
            saving && styles.disabled,
          ]}
        >
          <Text style={styles.saveText}>
            {saving ? "Saving AI settings…" : "Save AI settings"}
          </Text>
        </Pressable>
      </ScrollView>
    </View>
  )
}

/** Renders one web-aligned settings row. */
function SettingRow({
  label,
  description,
  children,
  colors,
}: {
  label: string
  description: string
  children: ReactNode
  colors: typeof darkColors
}) {
  return (
    <View style={[styles.settingRow, { borderBottomColor: colors.border }]}>
      <Text style={[styles.label, { color: colors.foreground }]}>{label}</Text>
      <Text style={[styles.description, { color: colors.muted }]}>
        {description}
      </Text>
      {children}
    </View>
  )
}

/** Renders one selected or unselected segmented choice. */
function Choice({
  label,
  selected,
  onPress,
  colors,
  accent,
}: {
  label: string
  selected: boolean
  onPress: () => void
  colors: typeof darkColors
  accent: string
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[
        styles.choice,
        {
          borderColor: selected ? accent : colors.border,
          backgroundColor: selected ? `${accent}1f` : colors.card,
        },
      ]}
    >
      <Text
        style={{ color: selected ? accent : colors.foreground, fontSize: 13 }}
      >
        {label}
      </Text>
    </Pressable>
  )
}

/** Renders a compact native picker substitute without adding a dependency. */
function PickerButton({
  label,
  value,
  onPress,
  colors,
}: {
  label: string
  value: string
  onPress: () => void
  colors: typeof darkColors
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      onPress={onPress}
      style={[styles.picker, { borderColor: colors.border }]}
    >
      <Text style={[styles.pickerLabel, { color: colors.muted }]}>{label}</Text>
      <Text
        numberOfLines={1}
        style={[styles.pickerValue, { color: colors.foreground }]}
      >
        {value}
      </Text>
      <WebArrowRightIcon size={18} color={colors.muted} strokeWidth={1.8} />
    </Pressable>
  )
}

const darkColors = {
  background: "#101010",
  card: "#191919",
  foreground: "#f7f7f7",
  muted: "#aaaaaa",
  border: "#303030",
}
const lightColors = {
  background: "#fafafa",
  card: "#ffffff",
  foreground: "#111111",
  muted: "#666666",
  border: "#dedede",
}
const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingBottom: 16,
    paddingHorizontal: 18,
  },
  back: { fontSize: 34, fontWeight: "300", lineHeight: 28 },
  reload: { fontSize: 28 },
  title: { fontSize: 18, fontWeight: "600" },
  intro: { fontSize: 14, lineHeight: 21, marginBottom: 26 },
  sectionTitle: { fontSize: 20, fontWeight: "600", marginBottom: 4 },
  sectionHint: { fontSize: 13, lineHeight: 19, marginBottom: 12 },
  sectionHeadingRow: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
    marginTop: 28,
  },
  sectionHeadingCopy: { flex: 1 },
  checkButton: {
    minHeight: 36,
    justifyContent: "center",
    paddingHorizontal: 4,
  },
  checkButtonText: { fontSize: 12, fontWeight: "700" },
  card: { borderRadius: 12, borderWidth: 1, overflow: "hidden" },
  settingRow: { borderBottomWidth: StyleSheet.hairlineWidth, padding: 16 },
  label: { fontSize: 14, fontWeight: "600" },
  description: { fontSize: 13, lineHeight: 19, marginTop: 5 },
  choiceRow: { flexDirection: "row", gap: 8, marginTop: 13 },
  choice: {
    alignItems: "center",
    borderRadius: 9,
    borderWidth: 1,
    flex: 1,
    minHeight: 40,
    justifyContent: "center",
    paddingHorizontal: 8,
  },
  accentRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 14,
  },
  swatch: {
    alignItems: "center",
    borderRadius: 18,
    height: 32,
    justifyContent: "center",
    width: 32,
  },
  selectedSwatch: { borderColor: "#ffffff", borderWidth: 3 },
  swatchMark: { color: "#ffffff", fontSize: 17, fontWeight: "700" },
  task: { borderBottomWidth: StyleSheet.hairlineWidth, padding: 16 },
  taskLabel: { fontSize: 15, fontWeight: "600" },
  taskDescription: {
    fontSize: 13,
    lineHeight: 19,
    marginTop: 5,
    marginBottom: 12,
  },
  providerRow: {
    gap: 12,
    padding: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  providerCopy: { gap: 5 },
  providerHeading: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 9,
  },
  providerName: { fontSize: 14, fontWeight: "600" },
  providerStatus: { fontSize: 12, fontWeight: "700" },
  providerMessage: { fontSize: 13, lineHeight: 19 },
  providerNote: { fontSize: 11, lineHeight: 17 },
  providerActions: { alignItems: "stretch", gap: 8 },
  providerButton: {
    alignItems: "center",
    borderRadius: 9,
    justifyContent: "center",
    minHeight: 42,
    paddingHorizontal: 13,
  },
  providerButtonText: { color: "#1b0d0a", fontSize: 13, fontWeight: "700" },
  outlineButton: {
    backgroundColor: "transparent",
    borderColor: "#505050",
    borderWidth: 1,
  },
  providerFooter: {
    fontSize: 12,
    lineHeight: 18,
    paddingHorizontal: 16,
    paddingVertical: 13,
  },
  connectionFeedback: {
    color: "#4ade80",
    fontSize: 13,
    lineHeight: 19,
    paddingHorizontal: 16,
    paddingBottom: 14,
  },
  accessSection: { borderTopWidth: StyleSheet.hairlineWidth, padding: 16 },
  accessRow: { gap: 4, marginTop: 10 },
  accessCopy: { gap: 2 },
  accessLabel: { fontSize: 13, fontWeight: "600" },
  accessDescription: { fontSize: 11, lineHeight: 17 },
  picker: {
    alignItems: "center",
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    minHeight: 42,
    marginTop: 8,
    paddingHorizontal: 11,
  },
  pickerLabel: { fontSize: 12, width: 76 },
  pickerValue: { flex: 1, fontSize: 13 },
  chevron: { fontSize: 22, marginLeft: 8 },
  save: {
    alignItems: "center",
    backgroundColor: "#ff8065",
    borderRadius: 10,
    marginTop: 16,
    minHeight: 48,
    justifyContent: "center",
  },
  saveText: { color: "#1b0d0a", fontSize: 14, fontWeight: "700" },
  disabled: { opacity: 0.55 },
  error: { color: "#ff6b61", fontSize: 13, marginTop: 15 },
  success: { color: "#4ade80", fontSize: 13, marginTop: 15 },
  centered: {
    alignItems: "center",
    flex: 1,
    gap: 12,
    justifyContent: "center",
  },
  body: { fontSize: 14 },
})

export default SettingsScreen
