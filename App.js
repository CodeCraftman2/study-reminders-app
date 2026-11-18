import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { ScrollView, View, Text, Pressable, Switch, StyleSheet, Platform, Alert, Modal, ActivityIndicator, useColorScheme } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as DocumentPicker from 'expo-document-picker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFonts, Inter_300Light, Inter_400Regular, Inter_500Medium, Inter_600SemiBold } from '@expo-google-fonts/inter';
import { readSheet, parseCSV, pdfItemsToRows, buildFromTable, buildEvents, isExam, nice, iso, addMinutes, itemKey, cleanText } from './src/parse';
import { Icon, slotIconName, eventIconName } from './src/Icons';
import { usePdfReader } from './src/PdfReader';
import { ensurePermission, applySchedule, topUp, loadSaved, clearAll, sendTest } from './src/scheduler';
import Dashboard, { CheckBox } from './src/Dashboard';
import { GlassScreen, Glass } from './src/Glass';
import { DARK, LIGHT, withFonts } from './src/theme';

const PLAN_KEY = 'study-reminders/plan';
const DONE_KEY = 'study-reminders/done';
const THEME_KEY = 'study-reminders/theme';
const THEMES = [['system', 'auto', 'Auto'], ['light', 'light', 'Light'], ['dark', 'dark', 'Dark']];
const PRE_STEPS = [0, 5, 10, 15, 30, 60];

const alert = (title, msg) => (Platform.OS === 'web' ? window.alert(`${title}\n\n${msg || ''}`) : Alert.alert(title, msg));
const confirm = (title, msg) => Platform.OS === 'web' ? Promise.resolve(window.confirm(`${title}\n\n${msg}`))
  : new Promise(r => Alert.alert(title, msg, [{ text: 'Cancel', style: 'cancel', onPress: () => r(false) }, { text: 'Remove', style: 'destructive', onPress: () => r(true) }]));

// Reads the picked file. Phones hand back different kinds of file links (file://, content://, names with
// spaces, brackets or "–"), and each reading method fails on some of them, so try several in turn.
const b64ToBytes = b64 => { const bin = global.atob(b64); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
async function readBytes(asset) {
  if (asset.file) return new Uint8Array(await asset.file.arrayBuffer());          // web
  const uris = [...new Set([asset.uri, (() => { try { return decodeURI(asset.uri); } catch { return asset.uri; } })()])];
  const methods = [
    async uri => { const { File } = require('expo-file-system'); return new Uint8Array(await new File(uri).arrayBuffer()); },
    async uri => { const Legacy = require('expo-file-system/legacy'); return b64ToBytes(await Legacy.readAsStringAsync(uri, { encoding: 'base64' })); },
    async uri => new Uint8Array(await (await fetch(uri)).arrayBuffer()),
  ];
  const errors = [];
  for (const read of methods) for (const uri of uris) {
    try { const bytes = await read(uri); if (bytes?.length) return bytes; errors.push('empty file'); }
    catch (e) { errors.push(e?.message || String(e)); }
  }
  console.warn('[Study Reminders] could not read file', asset.uri, errors);
  throw new Error('Could not open this file on your phone. Try saving it to your phone\'s Downloads folder first, or rename it without brackets or special dashes, then upload again.');
}

export default function App() {
  const [fontsLoaded, fontError] = useFonts({ Inter_300Light, Inter_400Regular, Inter_500Medium, Inter_600SemiBold });
  const systemDark = useColorScheme() === 'dark';
  const [themePref, setThemePref] = useState('system');   // 'system' | 'light' | 'dark'
  const dark = themePref === 'system' ? systemDark : themePref === 'dark';
  const c = dark ? DARK : LIGHT;
  useEffect(() => { AsyncStorage.getItem(THEME_KEY).then(v => v && setThemePref(v)).catch(() => {}); }, []);
  const chooseTheme = v => { setThemePref(v); AsyncStorage.setItem(THEME_KEY, v).catch(() => {}); };
  const s = useMemo(() => makeStyles(c, !!fontsLoaded), [dark, fontsLoaded]);
  const pdf = usePdfReader();

  const [plan, setPlan] = useState(null);
  const [opts, setOpts] = useState({ preMin: 10, brief: true, briefTime: '07:30' });
  const [showPast, setShowPast] = useState(false);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);
  const [editing, setEditing] = useState(null);   // { kind: 'slot'|'item'|'brief', index, time }
  const [done, setDone] = useState({});           // { [taskKey]: true }
  const [tab, setTab] = useState('plan');
  const doneRef = useRef({});

  const refreshStatus = useCallback(async (res) => {
    const saved = await loadSaved();
    let r = res;
    if (!r) {
      try { r = await topUp(doneRef.current); }
      catch (e) { console.warn('[Study Reminders] could not refresh reminders:', e?.message); r = { scheduled: 0, total: saved.events.length, error: e?.message }; }
    }
    const now = new Date(); const stamp = `${iso(now)}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    setStatus({ ...r, source: saved.source, next: saved.events.filter(e => e.when > stamp && !(e.key && doneRef.current[e.key])).slice(0, 3) });
  }, []);

  useEffect(() => {
    (async () => {
      try { const p = JSON.parse(await AsyncStorage.getItem(PLAN_KEY)); if (p?.plan) { setPlan(p.plan); setOpts(p.opts); setTab('progress'); } } catch {}
      try { const d = JSON.parse(await AsyncStorage.getItem(DONE_KEY)) || {}; doneRef.current = d; setDone(d); } catch {}
      refreshStatus();
    })();
  }, []);
  useEffect(() => { if (plan) AsyncStorage.setItem(PLAN_KEY, JSON.stringify({ plan, opts })); }, [plan, opts]);

  // Ticking a task saves it and (after a short pause) removes its upcoming reminders.
  const resync = useRef(null);
  const toggleDone = useCallback(key => {
    setDone(d => {
      const n = { ...d }; if (n[key]) delete n[key]; else n[key] = true;
      doneRef.current = n;
      AsyncStorage.setItem(DONE_KEY, JSON.stringify(n));
      return n;
    });
    clearTimeout(resync.current);
    resync.current = setTimeout(() => refreshStatus(), 1500);
  }, [refreshStatus]);

  const pick = async () => {
    let res;
    try { res = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true }); }
    catch (e) { return setMsg({ ok: false, text: `Could not open the file picker: ${e?.message || e}` }); }
    if (!res || res.canceled || !res.assets?.length) return;
    const asset = res.assets[0];
    setBusy(true); setMsg({ text: `Reading ${asset.name}…` });
    try {
      const ext = asset.name.split('.').pop().toLowerCase();
      const bytes = await readBytes(asset);
      let rows;
      if (ext === 'pdf') rows = pdfItemsToRows(await pdf.read(bytes));
      else if (['csv', 'tsv', 'txt'].includes(ext)) rows = parseCSV(new TextDecoder('utf-8').decode(bytes));
      else if (['xlsx', 'xls', 'xlsm', 'ods'].includes(ext)) rows = readSheet(bytes);
      else throw new Error('Please choose a PDF, CSV or Excel file.');
      const p = buildFromTable(rows, asset.name);
      const dates = [...new Set(p.items.map(i => i.date))].sort();
      setPlan(p);
      setMsg({ ok: true, text: `Found ${p.items.length} tasks across ${dates.length} days (${nice(dates[0])} – ${nice(dates[dates.length - 1])})` });
    } catch (e) { setMsg({ ok: false, text: e.message }); }
    setBusy(false);
  };

  const events = useMemo(() => (plan ? buildEvents(plan, opts) : []), [plan, opts]);
  const today = iso(new Date());
  const upcoming = events.filter(e => e.date >= today && !(e.key && done[e.key])).length;

  const turnOn = async () => {
    setBusy(true);
    try {
      if (Platform.OS !== 'web' && !(await ensurePermission())) {
        alert('Notifications are off', 'Allow notifications for this app in your phone Settings, then try again.');
      } else {
        const r = await applySchedule(events, plan.source, doneRef.current);
        await refreshStatus(r);
        alert('Reminders are on', r.web ? 'Open this app on your phone to get notifications.' : `${r.scheduled} reminders are scheduled on this phone.`);
      }
    } catch (e) { alert('Could not schedule', e.message); }
    setBusy(false);
  };

  const testNotification = async () => {
    if (Platform.OS === 'web') return alert('Phone only', 'Notifications work in the phone app.');
    try {
      if (await sendTest()) alert('Sent', 'A test notification will appear in 5 seconds.');
      else alert('Notifications are off', 'Allow notifications for this app in Settings.');
    } catch (e) { alert('Test failed', e.message); }
  };

  const days = useMemo(() => {
    if (!plan) return [];
    const by = {};
    plan.items.forEach((it, k) => (by[it.date] ||= []).push(k));
    return Object.keys(by).sort().filter(d => showPast || d >= today).map(d => ({ date: d, ks: by[d] }));
  }, [plan, showPast, today]);

  const update = fn => setPlan(p => { const n = { ...p, slots: p.slots.map(x => ({ ...x })), items: p.items.map(x => ({ ...x })) }; fn(n); return n; });
  const saveEdit = time => {
    const e = editing; setEditing(null);
    if (e.kind === 'brief') return setOpts(o => ({ ...o, briefTime: time }));
    update(n => { if (e.kind === 'slot') n.slots[e.index].time = time; else n.items[e.index].time = time; });
  };

  if (!fontsLoaded && !fontError) return <View style={{ flex: 1, backgroundColor: c.bg[0] }} />;

  const sw = { trackColor: { false: c.track, true: c.accent }, thumbColor: '#fff', activeThumbColor: '#fff' };

  return (
    <SafeAreaProvider>
      <GlassScreen c={c}>
      <SafeAreaView style={s.screen} edges={['top', 'left', 'right']}>
        <StatusBar style={dark ? 'light' : 'dark'} />
        {pdf.element}

        {/* Top bar */}
        <View style={s.topBar}>
          <View style={s.brand}>
            <View style={s.mark}><Icon name="logo" size={18} color={c.accent} strokeWidth={1.8} /></View>
            <Text style={s.brandText} numberOfLines={1}>Study Reminders</Text>
          </View>
          <Glass style={s.themeBar} radius={999} intensity={30}>
            {THEMES.map(([k, ic, label]) => (
              <Pressable key={k} onPress={() => chooseTheme(k)} style={[s.themeBtn, themePref === k && s.themeBtnOn]}
                accessibilityRole="button" accessibilityLabel={`${label} theme`} accessibilityState={{ selected: themePref === k }}>
                <Icon name={ic} size={16} color={themePref === k ? c.buttonInk : c.mute} strokeWidth={1.8} />
              </Pressable>
            ))}
          </Glass>
        </View>

        <ScrollView contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
          {plan && tab === 'progress' ? <Dashboard plan={plan} done={done} onToggle={toggleDone} today={today} c={c} /> : <>
            {!plan && (
              <View style={s.intro}>
                <Text style={s.introSmall}>Your semester,</Text>
                <Text style={s.introBig}>on schedule.</Text>
                <Text style={s.introText}>Upload your study plan. Your phone reminds you of every task on time, even when the app is closed.</Text>
              </View>
            )}

            {/* Reminders status */}
            <Glass style={s.card}>
              <Head s={s} c={c} icon="reminders" title="Active reminders" />
              {!status ? <ActivityIndicator color={c.accent} /> : status.total ? (
                <>
                  <View style={s.statusLine}>
                    <Text style={s.bigNum}>{status.web ? status.total : status.scheduled}</Text>
                    <Text style={s.bigNumLabel}>reminders on{status.source ? `\n${status.source}` : ''}</Text>
                  </View>
                  {status.next.map(e => (
                    <View key={e.id} style={s.nextRow}>
                      <View style={s.iconChip}><Icon name={eventIconName(e)} size={16} color={c.ink} /></View>
                      <View style={{ flex: 1 }}>
                        <Text style={s.nextTitle}>{nice(e.date)} · {e.time}</Text>
                        <Text style={s.muted} numberOfLines={1}>{e.body}</Text>
                      </View>
                    </View>
                  ))}
                </>
              ) : <Text style={s.muted}>None yet. Upload your plan below, then turn reminders on.</Text>}
              <View style={s.btnRow}>
                <Btn s={s} label="Send a test" onPress={testNotification} />
                <Btn s={s} label="Remove all" onPress={async () => { if (await confirm('Remove all reminders?', 'Your plan stays in the app; only the notifications are removed.')) { await clearAll(); refreshStatus(); } }} />
              </View>
            </Glass>

            {/* Upload */}
            <Glass style={s.card}>
              <Head s={s} c={c} icon="upload" title="Upload your plan" step="01" />
              <Pressable style={({ pressed }) => [s.drop, pressed && { opacity: 0.7 }]} onPress={pick} disabled={busy}>
                <View style={s.dropIcon}><Icon name="upload" size={22} color={c.accent} /></View>
                <Text style={s.dropText}>Choose a PDF, CSV or Excel file</Text>
                <Text style={[s.muted, { textAlign: 'center' }]}>Needs a “Date” column, or dates at the start of each line</Text>
              </Pressable>
              {msg && (
                <View style={s.msgRow}>
                  {msg.ok != null && <Icon name={msg.ok ? 'ok' : 'error'} size={16} color={msg.ok ? c.good : c.bad} />}
                  <Text style={[s.msg, msg.ok === true && { color: c.good }, msg.ok === false && { color: c.bad }]}>{msg.text}</Text>
                </View>
              )}
            </Glass>

            {plan && (
              <>
                {/* Times */}
                <Glass style={s.card}>
                  <Head s={s} c={c} icon="time" title="Set the times" step="02" />
                  {plan.slots.map((sl, i) => (
                    <View key={i} style={s.setRow}>
                      <View style={[s.setLabelBox, !sl.on && s.off]}><Icon name={slotIconName(i)} size={18} color={c.mute} /><Text style={s.setLabel} numberOfLines={1}>{cleanText(sl.short)}</Text></View>
                      <TimeChip s={s} time={sl.time} onPress={() => setEditing({ kind: 'slot', index: i, time: sl.time })} />
                      <Switch {...sw} value={sl.on} onValueChange={v => update(n => { n.slots[i].on = v; })} />
                    </View>
                  ))}
                  <View style={s.setRow}>
                    <View style={[s.setLabelBox, !opts.brief && s.off]}><Icon name="morning" size={18} color={c.mute} /><Text style={s.setLabel}>Morning overview</Text></View>
                    <TimeChip s={s} time={opts.briefTime} onPress={() => setEditing({ kind: 'brief', time: opts.briefTime })} />
                    <Switch {...sw} value={opts.brief} onValueChange={v => setOpts(o => ({ ...o, brief: v }))} />
                  </View>
                  <View style={[s.setRow, { flexDirection: 'column', alignItems: 'stretch', gap: 10 }]}>
                    <View style={s.setLabelBox}><Icon name="headsUp" size={18} color={c.mute} /><Text style={s.setLabel}>Heads-up before each task</Text></View>
                    <View style={s.pills}>
                      {PRE_STEPS.map(m => (
                        <Pressable key={m} onPress={() => setOpts(o => ({ ...o, preMin: m }))} style={[s.pill, opts.preMin === m && s.pillOn]}>
                          <Text style={[s.pillText, opts.preMin === m && s.pillTextOn]}>{m ? `${m} min` : 'Off'}</Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                </Glass>

                {/* Schedule */}
                <Glass style={s.card}>
                  <Head s={s} c={c} icon="plan" title="Your schedule" step="03"
                    right={<View style={s.inline}><Text style={s.muted}>Past</Text><Switch {...sw} value={showPast} onValueChange={setShowPast} /></View>} />
                  <Text style={[s.muted, { marginBottom: 12 }]}>Tick a task when it's done. Tap a time to change it, or the bell to mute that reminder.</Text>
                  {days.map(({ date, ks }) => {
                    const its = ks.map(k => plan.items[k]);
                    const exam = its.some(i => isExam(i.text));
                    const nDone = its.filter(i => done[itemKey(i)]).length, allDone = nDone === its.length;
                    return (
                      <View key={date} style={[s.day, exam && s.examDay, date < today && allDone && { opacity: 0.55 }]}>
                        <View style={s.dayHead}>
                          <Text style={s.dayTitle}>{nice(date)}{date === today ? ' · Today' : ''}</Text>
                          <View style={s.inline}>
                            {exam && <View style={s.tag}><Icon name="exam" size={12} color={c.examInk} /><Text style={[s.tagText, { color: c.examInk }]}>Exam</Text></View>}
                            {!!its[0].phase && !exam && <View style={s.tag}><Text style={s.tagText}>{its[0].phase}</Text></View>}
                            {allDone ? <Icon name="dayDone" size={18} color={c.accent} /> : <Text style={s.dayCount}>{nDone}/{its.length}</Text>}
                          </View>
                        </View>
                        <View style={s.dayTrack}><View style={[s.dayFill, { width: `${(nDone / its.length) * 100}%` }]} /></View>
                        {ks.map(k => {
                          const it = plan.items[k]; const sl = plan.slots[it.slot]; const on = it.on && sl.on;
                          const isDone = !!done[itemKey(it)];
                          return (
                            <View key={k} style={s.item}>
                              <CheckBox checked={isDone} onPress={() => toggleDone(itemKey(it))} c={c} />
                              <Icon name={isExam(it.text) ? 'exam' : slotIconName(it.slot)} size={16} color={on ? c.mute : c.faint} />
                              <Pressable onPress={() => setEditing({ kind: 'item', index: k, time: it.time || sl.time })} hitSlop={6}>
                                <Text style={[s.itemTime, it.time && s.itemTimeCustom, !on && s.off]}>{it.time || sl.time}</Text>
                              </Pressable>
                              <Text style={[s.itemText, isDone && s.itemDone]}>{cleanText(it.text)}</Text>
                              <Pressable hitSlop={10} onPress={() => update(n => { n.items[k].on = !n.items[k].on; })} accessibilityLabel={it.on ? 'Mute this reminder' : 'Unmute this reminder'}>
                                <Icon name={it.on ? 'bell' : 'bellOff'} size={17} color={it.on ? c.mute : c.faint} />
                              </Pressable>
                            </View>
                          );
                        })}
                      </View>
                    );
                  })}
                </Glass>
              </>
            )}
          </>}
          <View style={{ height: 16 }} />
        </ScrollView>

        {/* Bottom bar: tabs + main action (sits below the list, never on top of it) */}
        {plan && (
          <SafeAreaView edges={['bottom']} style={s.navWrap}>
            <Glass style={s.nav} radius={999} intensity={55}>
              {[['progress', 'progress', 'Progress'], ['plan', 'plan', 'Plan']].map(([k, ic, label]) => (
                <Pressable key={k} onPress={() => setTab(k)} style={[s.navBtn, tab === k && s.navBtnOn]} accessibilityRole="tab" accessibilityState={{ selected: tab === k }}>
                  <Icon name={ic} size={18} color={tab === k ? c.buttonInk : c.mute} strokeWidth={1.8} />
                  {tab === k && <Text style={s.navText}>{label}</Text>}
                </Pressable>
              ))}
              <View style={{ flex: 1 }} />
              {tab === 'plan' ? (
                <Pressable style={({ pressed }) => [s.cta, (busy || pressed) && { opacity: 0.75 }]} onPress={turnOn} disabled={busy}>
                  {busy ? <ActivityIndicator color={c.onAccent} /> : <><Icon name="reminders" size={16} color={c.onAccent} strokeWidth={2} /><Text style={s.ctaText}>Turn on · {upcoming}</Text></>}
                </Pressable>
              ) : (
                <Text style={s.navHint}>{upcoming} reminders</Text>
              )}
            </Glass>
          </SafeAreaView>
        )}

        <TimeEditor s={s} c={c} editing={editing} onCancel={() => setEditing(null)} onSave={saveEdit} />
      </SafeAreaView>
      </GlassScreen>
    </SafeAreaProvider>
  );
}

const Head = ({ s, c, icon, title, step, right }) => (
  <View style={s.head}>
    <View style={s.iconChip}><Icon name={icon} size={16} color={c.ink} /></View>
    <View style={{ flex: 1 }}>
      {step && <Text style={s.step}>Step {step}</Text>}
      <Text style={s.h2}>{title}</Text>
    </View>
    {right}
  </View>
);
const Btn = ({ s, label, onPress }) => <Pressable style={({ pressed }) => [s.btn, pressed && { opacity: 0.6 }]} onPress={onPress}><Text style={s.btnText}>{label}</Text></Pressable>;
const TimeChip = ({ s, time, onPress }) => <Pressable onPress={onPress} style={s.chip}><Text style={s.chipText}>{time}</Text></Pressable>;

function TimeEditor({ s, c, editing, onCancel, onSave }) {
  const [t, setT] = useState('09:00');
  useEffect(() => { if (editing) setT(editing.time); }, [editing]);
  const [h, m] = t.split(':').map(Number);
  const hh = `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}`;
  return (
    <Modal visible={!!editing} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable style={s.backdrop} onPress={onCancel}>
        <Pressable style={s.sheetWrap} onPress={() => {}}>
          <View style={s.sheet}>
            <Head s={s} c={c} icon="time" title="Pick a time" />
            <View style={s.bigTimeRow}><Text style={s.bigTime}>{hh}</Text><Text style={s.ampm}>{h < 12 ? 'AM' : 'PM'}</Text></View>
            <View style={s.stepRow}>
              {[[-60, '−1 h'], [-15, '−15'], [-5, '−5'], [5, '+5'], [15, '+15'], [60, '+1 h']].map(([d, l]) => (
                <Pressable key={l} style={s.stepBtn} onPress={() => setT(x => addMinutes(x, d))}><Text style={s.stepBtnText}>{l}</Text></Pressable>
              ))}
            </View>
            <View style={[s.btnRow, { justifyContent: 'flex-end', marginTop: 18 }]}>
              <Btn s={s} label="Cancel" onPress={onCancel} />
              <Pressable style={s.save} onPress={() => onSave(t)}><Text style={s.saveText}>Save</Text></Pressable>
            </View>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const hair = StyleSheet.hairlineWidth * 2;
const makeStyles = (c, fonts) => StyleSheet.create(withFonts({
  screen: { flex: 1, backgroundColor: 'transparent' },
  content: { paddingHorizontal: 16, paddingTop: 4, maxWidth: 640, width: '100%', alignSelf: 'center' },

  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12, maxWidth: 640, width: '100%', alignSelf: 'center', gap: 10 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  mark: { width: 34, height: 34, borderRadius: 11, backgroundColor: c.chip, borderWidth: hair, borderColor: c.line, alignItems: 'center', justifyContent: 'center' },
  brandText: { color: c.ink, fontSize: 15, fontWeight: '600', letterSpacing: -0.4, flexShrink: 1 },
  themeBar: { flexDirection: 'row', padding: 3, gap: 1 },
  themeBtn: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  themeBtnOn: { backgroundColor: c.button },

  intro: { paddingTop: 18, paddingBottom: 22 },
  introSmall: { color: c.faint, fontSize: 34, fontWeight: '300', letterSpacing: -1.2 },
  introBig: { color: c.ink, fontSize: 40, fontWeight: '300', letterSpacing: -1.6, marginTop: -4 },
  introText: { color: c.mute, fontSize: 14, lineHeight: 21, marginTop: 12 },

  card: { padding: 18, marginBottom: 12 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 14 },
  iconChip: { width: 32, height: 32, borderRadius: 10, backgroundColor: c.chip, borderWidth: hair, borderColor: c.line, alignItems: 'center', justifyContent: 'center' },
  step: { color: c.faint, fontSize: 11, fontWeight: '500', letterSpacing: 0.6, textTransform: 'uppercase' },
  h2: { fontSize: 16, fontWeight: '600', color: c.ink, letterSpacing: -0.2 },
  muted: { color: c.mute, fontSize: 13, lineHeight: 18 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 8 },

  statusLine: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 8 },
  bigNum: { color: c.ink, fontSize: 44, fontWeight: '300', letterSpacing: -1.5, fontVariant: ['tabular-nums'] },
  bigNumLabel: { color: c.mute, fontSize: 13, lineHeight: 18, flex: 1 },
  nextRow: { flexDirection: 'row', gap: 12, alignItems: 'center', paddingVertical: 8, borderTopWidth: hair, borderTopColor: c.line },
  nextTitle: { color: c.ink, fontWeight: '500', fontSize: 14 },
  btnRow: { flexDirection: 'row', gap: 8, marginTop: 14, flexWrap: 'wrap' },
  btn: { borderWidth: hair, borderColor: c.line, backgroundColor: c.chip, borderRadius: 999, paddingVertical: 9, paddingHorizontal: 16 },
  btnText: { color: c.ink, fontWeight: '500', fontSize: 13 },

  drop: { borderWidth: 1.2, borderStyle: 'dashed', borderColor: c.faint, borderRadius: 18, padding: 22, alignItems: 'center', gap: 8 },
  dropIcon: { width: 48, height: 48, borderRadius: 16, backgroundColor: c.chip, alignItems: 'center', justifyContent: 'center', borderWidth: hair, borderColor: c.line },
  dropText: { color: c.ink, fontWeight: '600', fontSize: 15 },
  msgRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', marginTop: 12 },
  msg: { color: c.mute, fontSize: 13, flex: 1, lineHeight: 18 },

  setRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderTopWidth: hair, borderTopColor: c.line },
  setLabelBox: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
  setLabel: { color: c.ink, fontWeight: '500', fontSize: 14, flexShrink: 1 },
  off: { opacity: 0.4 },
  chip: { backgroundColor: c.chip, borderRadius: 10, paddingVertical: 6, paddingHorizontal: 12, borderWidth: hair, borderColor: c.line },
  chipText: { color: c.ink, fontWeight: '500', fontSize: 14, fontVariant: ['tabular-nums'] },
  pills: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  pill: { paddingVertical: 6, paddingHorizontal: 11, borderRadius: 999, borderWidth: hair, borderColor: c.line, backgroundColor: c.chip },
  pillOn: { backgroundColor: c.button, borderColor: c.button },
  pillText: { color: c.mute, fontSize: 12, fontWeight: '500' },
  pillTextOn: { color: c.buttonInk },

  day: { borderRadius: 16, borderWidth: hair, borderColor: c.line, padding: 14, marginBottom: 10 },
  examDay: { backgroundColor: c.exam },
  dayHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 },
  dayTitle: { color: c.ink, fontWeight: '600', fontSize: 14, flexShrink: 1 },
  tag: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: c.chip, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3, borderWidth: hair, borderColor: c.line },
  tagText: { color: c.mute, fontSize: 11, fontWeight: '500' },
  dayCount: { color: c.mute, fontWeight: '500', fontSize: 12, fontVariant: ['tabular-nums'] },
  dayTrack: { height: 3, borderRadius: 2, backgroundColor: c.track, marginBottom: 6, overflow: 'hidden' },
  dayFill: { height: '100%', backgroundColor: c.accent, borderRadius: 2 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 7 },
  itemTime: { color: c.ink, fontWeight: '500', fontSize: 13, width: 42, fontVariant: ['tabular-nums'] },
  itemTimeCustom: { color: c.accent, textDecorationLine: 'underline' },
  itemText: { flex: 1, color: c.ink, fontSize: 14, lineHeight: 20 },
  itemDone: { color: c.faint, textDecorationLine: 'line-through' },

  navWrap: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 10, width: '100%', maxWidth: 640, alignSelf: 'center' },
  nav: { flexDirection: 'row', alignItems: 'center', padding: 6, gap: 4 },
  navBtn: { height: 44, minWidth: 44, paddingHorizontal: 12, borderRadius: 22, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  navBtnOn: { backgroundColor: c.button, paddingHorizontal: 16 },
  navText: { color: c.buttonInk, fontWeight: '600', fontSize: 13 },
  navHint: { color: c.mute, fontSize: 12, paddingRight: 12 },
  cta: { height: 44, borderRadius: 22, paddingHorizontal: 16, backgroundColor: c.accent, flexDirection: 'row', alignItems: 'center', gap: 8 },
  ctaText: { color: c.onAccent, fontWeight: '600', fontSize: 13 },

  backdrop: { flex: 1, backgroundColor: c.dark ? 'rgba(0,0,0,0.55)' : 'rgba(10,30,20,0.25)', justifyContent: 'center', padding: 20 },
  sheetWrap: { maxWidth: 420, width: '100%', alignSelf: 'center' },
  sheet: { padding: 20, borderRadius: 26, backgroundColor: c.card, borderWidth: hair, borderColor: c.glassBorder },
  bigTimeRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center', marginVertical: 12, gap: 6 },
  bigTime: { fontSize: 64, fontWeight: '300', color: c.ink, letterSpacing: -2.5, fontVariant: ['tabular-nums'] },
  ampm: { fontSize: 18, fontWeight: '400', color: c.mute, marginBottom: 12 },
  stepRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' },
  stepBtn: { backgroundColor: c.chip, borderRadius: 12, paddingVertical: 10, minWidth: 64, alignItems: 'center', borderWidth: hair, borderColor: c.line },
  stepBtnText: { color: c.ink, fontWeight: '500', fontSize: 13 },
  save: { backgroundColor: c.button, borderRadius: 999, paddingVertical: 10, paddingHorizontal: 22 },
  saveText: { color: c.buttonInk, fontWeight: '600', fontSize: 14 },
}, fonts));
