// Replacing virtualized controls must not discard the user's keyboard position.
// Stable keys are compared as strings, never interpolated into CSS selectors.
export function replaceFocusedContent(container,html,{fallback=null,active=document.activeElement}={}){
  const owned=!!active&&!!container.contains?.(active),key=owned?active.closest?.('[data-focus-key]')?.getAttribute('data-focus-key'):null;
  container.innerHTML=html;
  if(!owned)return;
  const replacement=key==null?null:[...container.querySelectorAll('[data-focus-key]')].find(element=>element.getAttribute('data-focus-key')===key&&!element.disabled);
  (replacement||fallback)?.focus({preventScroll:true});
}

export function trapDialogTab(dialog,event){
  if(event.key!=='Tab'||event.ctrlKey||event.metaKey||event.altKey)return false;
  const controls=[...dialog.querySelectorAll('a[href],button,input,select,textarea,summary,[tabindex]')].filter(element=>!element.disabled&&element.tabIndex>=0&&!element.hidden&&element.getClientRects().length);
  const active=dialog.ownerDocument.activeElement,first=controls[0],last=controls.at(-1);
  if(!controls.length){event.preventDefault();dialog.focus({preventScroll:true});return true;}
  if(!dialog.contains(active)||event.shiftKey&&active===first||!event.shiftKey&&active===last){event.preventDefault();(event.shiftKey?last:first).focus();return true;}
  return false;
}
