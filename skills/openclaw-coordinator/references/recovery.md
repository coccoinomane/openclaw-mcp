# Recovering an uncertain operation

After a timeout or disconnect, inspect the recorded operation using its original identifier before retrying. Preserve the original arguments; a new identifier can create duplicate work.

If a thread or channel already exists, retain its link even when the next step failed. Distinguish request publication, agent execution and answer delivery; success in one does not prove success in the others. Use the tool's reported status and recovery instructions rather than guessing from elapsed time.

Do not create a replacement thread merely because a response was lost. Do not delete operation records or locks to force a retry. Once the previous outcome is understood, continue the verified thread when another turn is needed.
