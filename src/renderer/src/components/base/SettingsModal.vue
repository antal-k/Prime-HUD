<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { useSettings } from '../../features/settings/composables/useSettings';
import { usePrimeCam } from '../../features/primecam/usePrimeCam';
import BaseButton from './BaseButton.vue';
import BaseCheckbox from './BaseCheckbox.vue';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const { settings, isLoading, isSaving, fetchSettings, saveSettings } = useSettings();

// --- PrimeCam ---
const primecam = usePrimeCam();
const primecamUrl = ref('');
const primecamKey = ref('');
const primecamChecked = ref(false);

watch(() => props.open, async (val) => {
  if (!val) return;
  primecamChecked.value = false;
  await fetchSettings();
  primecamUrl.value = settings.value.primecamUrl;
  primecamKey.value = settings.value.primecamKey;
  if (settings.value.primecamUrl) {
    await primecam.fetchCameras();
    primecamChecked.value = true;
  }
});

const savePrimeCam = async () => {
  await saveSettings({ primecamUrl: primecamUrl.value.trim(), primecamKey: primecamKey.value.trim() });
  await primecam.fetchCameras();
  primecamChecked.value = true;
};

const primecamStatus = computed(() => {
  if (!primecamChecked.value) return null;
  if (!primecam.configured.value) return { ok: false, message: 'Not set: the HUD shows avatars only.' };
  if (primecam.error.value) return { ok: false, message: primecam.error.value };
  const live = primecam.cameras.value.filter((c) => c.connected).length;
  return { ok: true, message: `Connected: ${live} camera${live === 1 ? '' : 's'} live.` };
});

// --- GSI Config Installation ---
const steamPath = ref('C:\\Program Files (x86)\\Steam');
const gsiStatus = ref<{ ok: boolean; message: string } | null>(null);
const isInstallingGsi = ref(false);

const browseSteamFolder = async () => {
  const selected = await window.electron.ipcRenderer.invoke('select-folder', steamPath.value);
  if (selected) {
    steamPath.value = selected;
    gsiStatus.value = null;
  }
};

const installGsiCfg = async () => {
  isInstallingGsi.value = true;
  gsiStatus.value = null;
  try {
    gsiStatus.value = await window.electron.ipcRenderer.invoke('install-gsi-cfg', steamPath.value);
  } finally {
    isInstallingGsi.value = false;
  }
};
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="open"
        class="fixed inset-0 z-50 flex items-end justify-start"
        @click.self="emit('close')"
      >
        <!-- Backdrop -->
        <div class="absolute inset-0 bg-black/50" @click="emit('close')" />

        <!-- Panel — anchored to bottom-left near the sidebar -->
        <div class="relative z-10 ml-4 mb-16 w-96 max-h-[calc(100vh-5rem)] overflow-y-auto bg-surface border border-zinc-700 rounded-xl shadow-2xl p-5 flex flex-col gap-5">
          
          <div class="flex items-center justify-between">
            <h2 class="text-text-main font-bold text-base">Settings</h2>
            <BaseButton @click="emit('close')" variant="ghost" size="sm">
              <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </BaseButton>
          </div>

          <div v-if="isLoading" class="text-zinc-400 text-sm text-center py-4">Loading…</div>

          <template v-else>
            <!-- Section: Match -->
            <div>
              <p class="text-xs font-semibold capitalize text-zinc-500 mb-3">Match Automation</p>

              <!-- Auto Switch Sides -->
              <div class="flex items-center justify-between">
                <div>
                  <p class="text-sm font-medium text-zinc-200">Auto Switch Sides</p>
                  <p class="text-xs text-zinc-500 mt-0.5">Automatically flip team sides at halftime</p>
                </div>
                <BaseCheckbox v-model="settings.autoSwitchSides" :disabled="isSaving" size="md" class="text-primary" />
              </div>
            </div>

            <!-- Section: CS2 Integration -->
            <div class="border-t border-border pt-4">
              <p class="text-xs font-semibold capitalize text-zinc-500 mb-3">CS2 Integration</p>

              <div class="flex flex-col gap-2">
                <p class="text-sm font-medium text-zinc-200">Install GSI Config</p>
                <p class="text-xs text-zinc-500">Select your Steam root folder. The config file will be written to your CS2 cfg directory.</p>

                <!-- Path selector -->
                <div class="flex gap-2 mt-1">
                  <input
                    v-model="steamPath"
                    type="text"
                    placeholder="C:\Program Files (x86)\Steam"
                    class="flex-1 min-w-0 bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-primary"
                  />
                  <BaseButton
                    @click="browseSteamFolder"
                    variant="secondary"
                    size="sm"
                  >
                    Browse
                  </BaseButton>
                </div>

                <BaseButton
                  @click="installGsiCfg"
                  :disabled="isInstallingGsi || !steamPath"
                  variant="primary"
                  class="flex-1 justify-center"
                >
                  {{ isInstallingGsi ? 'Installing…' : 'Install GSI Config' }}
                </BaseButton>

                <!-- Status feedback -->
                <div
                  v-if="gsiStatus"
                  class="text-xs rounded-lg px-3 py-2 whitespace-pre-wrap"
                  :class="gsiStatus.ok ? 'bg-emerald-900/40 text-emerald-400 border border-emerald-800/50' : 'bg-red-900/40 text-red-400 border border-red-800/50'"
                >
                  {{ gsiStatus.message }}
                </div>
              </div>
            </div>

            <!-- Section: PrimeCam -->
            <div class="border-t border-border pt-4">
              <p class="text-xs font-semibold capitalize text-zinc-500 mb-3">Player Cameras (PrimeCam)</p>

              <div class="flex flex-col gap-2">
                <p class="text-xs text-zinc-500">The observed player's camera appears in the HUD. Paste the server's address and its view key (the <code>key=</code> part of an OBS URL).</p>
                <input
                  v-model="primecamUrl"
                  type="text"
                  placeholder="https://prime.example.com"
                  class="bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-primary"
                />
                <input
                  v-model="primecamKey"
                  type="password"
                  placeholder="View key"
                  autocomplete="off"
                  class="bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-primary"
                />
                <BaseButton
                  @click="savePrimeCam"
                  :disabled="isSaving || primecam.isLoading.value"
                  variant="primary"
                  class="flex-1 justify-center"
                >
                  {{ isSaving || primecam.isLoading.value ? 'Checking…' : 'Save & Check' }}
                </BaseButton>
                <div
                  v-if="primecamStatus"
                  class="text-xs rounded-lg px-3 py-2"
                  :class="primecamStatus.ok ? 'bg-emerald-900/40 text-emerald-400 border border-emerald-800/50' : 'bg-red-900/40 text-red-400 border border-red-800/50'"
                >
                  {{ primecamStatus.message }}
                </div>
              </div>
            </div>
          </template>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.fade-enter-active, .fade-leave-active { transition: opacity 0.15s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
