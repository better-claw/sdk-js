export const FILE_DEMO_PROMPT =
  'Create a downloadable file named project-plan.csv with columns Task,Owner,Status and five sample project tasks. ' +
  'Save and attach the CSV as a file deliverable so I can download it. Do not just paste the CSV into the chat.';

/** Save the File returned by client.chats.getDeliverable() in the browser. */
export function saveFile(file: File): void {
  const objectUrl = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = file.name;
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Give the browser time to start the download before releasing its URL.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
  }
}
