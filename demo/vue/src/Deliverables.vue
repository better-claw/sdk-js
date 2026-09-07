<script setup lang="ts">
import { ref } from 'vue';
import type { ChatMessage } from '@better-claw/sdk';
import { useBetterClaw } from '@better-claw/sdk/vue';
import { saveFile } from '../../files';

const props = defineProps<{ message: ChatMessage }>();
const client = useBetterClaw();
const downloading = ref<number | null>(null);
const error = ref<string | null>(null);

async function download(index: number) {
  downloading.value = index;
  error.value = null;
  try {
    const file = await client.chats.getDeliverable(props.message, index);
    saveFile(file);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not download the file. Please try again.';
  } finally {
    downloading.value = null;
  }
}
</script>

<template>
  <div v-if="message.deliverable?.length" class="deliverables">
    <ul aria-label="Generated files">
      <li v-for="(file, index) in message.deliverable" :key="index">
        <button type="button" :disabled="downloading !== null" @click="download(index)">
          {{ downloading === index ? 'Downloading' : 'Download' }} {{ file.filename }}
        </button>
      </li>
    </ul>
    <p v-if="error" role="alert">{{ error }}</p>
  </div>
</template>
