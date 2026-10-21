import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Cloud, Key, Cpu, Network } from "../icons";
import { useSettingsStore } from "../../stores/settingsStore";
import { usePolicyModeOptions, usePolicySnapshot } from "../../hooks/usePolicy";
import { isModeAllowedByPolicy } from "../../stores/policyRules";
import { requestSignIn } from "../../utils/requestSignIn";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { InferenceModeSelector, SettingsRow } from "../ui/SettingsSection";
import type { InferenceModeOption } from "../ui/SettingsSection";
import { Toggle } from "../ui/toggle";
import TranscriptionModelPicker from "../TranscriptionModelPicker";
import type { InferenceMode } from "../../types/electron";
import { getMeetingStreamingTranscriptionProviders } from "../../models/ModelRegistry";

const MEETING_BYOK_PROVIDER_IDS = getMeetingStreamingTranscriptionProviders().map(
  (provider) => provider.id
);

export function MeetingSpeakerDetectionRow() {
  const { t } = useTranslation();
  const speakerDiarizationEnabled = useSettingsStore((s) => s.speakerDiarizationEnabled);
  const setSpeakerDiarizationEnabled = useSettingsStore((s) => s.setSpeakerDiarizationEnabled);

  return (
    <SettingsRow
      label={t("settings.meeting.speakerDetection.title")}
      description={t("settings.meeting.speakerDetection.description")}
    >
      <Toggle checked={speakerDiarizationEnabled} onChange={setSpeakerDiarizationEnabled} />
    </SettingsRow>
  );
}

function MeetingEchoCancellationRow() {
  const { t } = useTranslation();
  const meetingAecEnabled = useSettingsStore((s) => s.meetingAecEnabled);
  const setMeetingAecEnabled = useSettingsStore((s) => s.setMeetingAecEnabled);

  return (
    <SettingsRow
      label={t("settingsPage.transcription.aec.toggle.title")}
      description={t("settingsPage.transcription.aec.toggle.description")}
    >
      <Toggle checked={meetingAecEnabled} onChange={setMeetingAecEnabled} />
    </SettingsRow>
  );
}

function MeetingScreenKeyframesRow() {
  const { t } = useTranslation();
  const enabled = useSettingsStore((s) => s.meetingScreenKeyframesEnabled);
  const setEnabled = useSettingsStore((s) => s.setMeetingScreenKeyframesEnabled);

  return (
    <SettingsRow
      label={t("settings.meeting.screenKeyframes.title")}
      description={t("settings.meeting.screenKeyframes.description")}
    >
      <Toggle checked={enabled} onChange={setEnabled} />
    </SettingsRow>
  );
}

// Text field that saves when it loses focus, so a half-typed URL or command
// never fires the hook.
function HookField({
  label,
  description,
  placeholder,
  value,
  onSave,
}: {
  label: string;
  description: string;
  placeholder: string;
  value: string;
  onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-foreground">{label}</p>
      <Input
        dir="ltr"
        spellCheck={false}
        placeholder={placeholder}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const trimmed = draft.trim();
          if (trimmed !== value) onSave(trimmed);
        }}
        className="font-mono text-xs"
      />
      <p className="text-xs text-muted-foreground/70">{description}</p>
    </div>
  );
}

function MeetingFinishedHookRows() {
  const { t } = useTranslation();
  const url = useSettingsStore((s) => s.meetingFinishedWebhookUrl);
  const setUrl = useSettingsStore((s) => s.setMeetingFinishedWebhookUrl);
  const command = useSettingsStore((s) => s.meetingFinishedCommand);
  const setCommand = useSettingsStore((s) => s.setMeetingFinishedCommand);

  return (
    <div className="space-y-3 border-t border-border/70 pt-4">
      <div>
        <p className="text-sm font-medium text-foreground">
          {t("settings.meeting.finishedHook.title")}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("settings.meeting.finishedHook.description")}
        </p>
      </div>
      <HookField
        label={t("settings.meeting.finishedHook.urlLabel")}
        description={t("settings.meeting.finishedHook.urlDescription")}
        placeholder="http://localhost:8787/meeting"
        value={url}
        onSave={setUrl}
      />
      <HookField
        label={t("settings.meeting.finishedHook.commandLabel")}
        description={t("settings.meeting.finishedHook.commandDescription")}
        placeholder={'my-agent ingest "$OPENWHISPR_MEETING_JSON"'}
        value={command}
        onSave={setCommand}
      />
    </div>
  );
}

const noop = () => {};

export function MeetingTranscriptionPanel() {
  const { t } = useTranslation();
  const policySnapshot = usePolicySnapshot();

  const {
    isSignedIn,
    meetingTranscriptionMode,
    setMeetingTranscriptionMode,
    setMeetingUseLocalWhisper,
    meetingWhisperModel,
    setMeetingWhisperModel,
    meetingLocalTranscriptionProvider,
    setMeetingLocalTranscriptionProvider,
    meetingParakeetModel,
    setMeetingParakeetModel,
    meetingCohereModel,
    setMeetingCohereModel,
    meetingCloudTranscriptionProvider,
    setMeetingCloudTranscriptionProvider,
    meetingCloudTranscriptionModel,
    setMeetingCloudTranscriptionModel,
    meetingCloudTranscriptionBaseUrl,
    setMeetingCloudTranscriptionBaseUrl,
    setMeetingCloudTranscriptionMode,
  } = useSettingsStore();
  const {
    modes: transcriptionModes,
    effectiveMode: effectiveTranscriptionMode,
    isModeAllowed,
  } = usePolicyModeOptions<InferenceModeOption>(
    [
      {
        id: "openwhispr",
        label: t("settingsPage.transcription.modes.openwhispr"),
        description: t("settingsPage.transcription.modes.openwhisprDesc"),
        icon: <Cloud className="w-4 h-4" />,
        disabled: !isSignedIn,
        signInRequired: !isSignedIn,
      },
      {
        id: "providers",
        label: t("settingsPage.transcription.modes.providers"),
        description: t("settingsPage.transcription.modes.providersDesc"),
        icon: <Key className="w-4 h-4" />,
      },
      {
        id: "local",
        label: t("settingsPage.transcription.modes.local"),
        description: t("settingsPage.transcription.modes.localDesc"),
        icon: <Cpu className="w-4 h-4" />,
      },
      {
        id: "self-hosted",
        label: t("settingsPage.transcription.modes.selfHosted"),
        description: t("settingsPage.transcription.modes.selfHostedDesc"),
        icon: <Network className="w-4 h-4" />,
        disabled: true,
        badge: t("common.comingSoon"),
      },
    ],
    "transcription",
    meetingTranscriptionMode,
    { byokProviders: MEETING_BYOK_PROVIDER_IDS }
  );
  const handleTranscriptionModeSelect = (mode: InferenceMode) => {
    if (!isModeAllowed(mode)) return;
    if (mode === "self-hosted") return;
    if (mode === "openwhispr" && !isSignedIn) {
      requestSignIn();
      return;
    }
    if (mode === effectiveTranscriptionMode) return;
    setMeetingTranscriptionMode(mode);
    setMeetingUseLocalWhisper(mode === "local");
    setMeetingCloudTranscriptionMode(mode === "openwhispr" ? "openwhispr" : "byok");
  };

  const handleLocalTranscriptionModelSelect = useCallback(
    (modelId: string, providerId?: string) => {
      const provider = providerId ?? meetingLocalTranscriptionProvider;
      if (provider === "nvidia") {
        setMeetingParakeetModel(modelId);
      } else if (provider === "cohere") {
        setMeetingCohereModel(modelId);
      } else {
        setMeetingWhisperModel(modelId);
      }
    },
    [
      meetingLocalTranscriptionProvider,
      setMeetingParakeetModel,
      setMeetingCohereModel,
      setMeetingWhisperModel,
    ]
  );

  const renderTranscriptionPicker = (mode: "cloud" | "local") => (
    <TranscriptionModelPicker
      streamingOnly
      transcriptionContext="meeting"
      selectedCloudProvider={meetingCloudTranscriptionProvider}
      onCloudProviderSelect={setMeetingCloudTranscriptionProvider}
      selectedCloudModel={meetingCloudTranscriptionModel}
      onCloudModelSelect={setMeetingCloudTranscriptionModel}
      selectedLocalModel={
        meetingLocalTranscriptionProvider === "nvidia"
          ? meetingParakeetModel
          : meetingLocalTranscriptionProvider === "cohere"
            ? meetingCohereModel
            : meetingWhisperModel
      }
      onLocalModelSelect={handleLocalTranscriptionModelSelect}
      selectedLocalProvider={meetingLocalTranscriptionProvider}
      onLocalProviderSelect={setMeetingLocalTranscriptionProvider}
      useLocalWhisper={mode === "local"}
      onModeChange={noop}
      mode={mode}
      cloudTranscriptionBaseUrl={meetingCloudTranscriptionBaseUrl}
      setCloudTranscriptionBaseUrl={setMeetingCloudTranscriptionBaseUrl}
      variant="settings"
    />
  );

  // Only true when the org's policy actually allows the enterprise
  // transcription mode — an empty list can also mean e.g. a self-hosted-only
  // policy, where this specific explanation would be false.
  const emptyListIsEnterpriseOnly =
    transcriptionModes.length === 0 &&
    isModeAllowedByPolicy(policySnapshot, "transcription", "enterprise");

  return (
    <div className="space-y-3">
      {emptyListIsEnterpriseOnly && (
        <p className="text-sm text-muted-foreground">
          {t("settingsPage.transcription.meetingEnterpriseOnly")}
        </p>
      )}
      <InferenceModeSelector
        modes={transcriptionModes}
        activeMode={effectiveTranscriptionMode}
        onSelect={handleTranscriptionModeSelect}
      />

      {effectiveTranscriptionMode === "openwhispr" && !isSignedIn && (
        <p className="text-sm text-muted-foreground">
          {t("settingsPage.transcription.meetingCloudSignedOut")}{" "}
          <Button variant="link" className="h-auto p-0" onClick={requestSignIn}>
            {t("common.signIn")}
          </Button>
        </p>
      )}
      {effectiveTranscriptionMode === "providers" && renderTranscriptionPicker("cloud")}
      {effectiveTranscriptionMode === "local" && renderTranscriptionPicker("local")}
      <MeetingSpeakerDetectionRow />
      <MeetingEchoCancellationRow />
      <MeetingScreenKeyframesRow />
      <MeetingFinishedHookRows />
    </div>
  );
}
