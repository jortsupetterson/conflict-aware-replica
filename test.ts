import { LIWRegister } from "./src";

const obj = { field: new LIWRegister(true) };

const checkbox = document.createElement("input");
checkbox.type = "checkbox";
checkbox.checked = Boolean(obj.field.value);

obj.field.onresolved = (resolved) => {
  // Update the field state
  obj.field = resolved;
  checkbox.checked = Boolean(resolved.value);
};

obj.field.onconflict = (received, stored) => {
  return new Promise((resolve, reject) => {
    document.createElement("button").addEventListener("click", () => {
      resolve(received);
    });
    document.createElement("button").addEventListener("click", () => {
      resolve(stored);
    });
  });
};

//** RESOLVED FROM A MESSAGE BODY AS AN OBJECT WITH THE DATA-ONLY PROPERTIES OF A LIW REGISTER */
const anotherNodesValue = new LIWRegister(false);
const anotherNodesSnapshot = anotherNodesValue.snapshot();
/** If there is a hint of clock skew
 * or bad network conditions at the time of delivery,
 * the onconflict handler will be called, and when
 * the promise resolves, the onresolved handler will be called.
 * Otherwise, onresolved will be called immediately.
 */
await obj.field.resolveIntent(anotherNodesSnapshot);
/**
 * It will be "automatically" eventually resolved
 * and reflected everywhere you reflect it in the onresolved handler.
 * At the very least, you should reflect it back to the object field
 * that stores the register you just resolved.
 */
