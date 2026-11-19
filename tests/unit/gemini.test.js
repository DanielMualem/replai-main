const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Must set dbPath before requiring gemini (it loads db.js which opens the database)
const config = require('../../src/config');
config.dbPath = ':memory:';

const { detectEscalation, buildCustomerMemoryPrompt, mergeFacts, stripLeakedReasoning, summarizeConversation, detectHallucinatedBooking, detectBookingTimeMismatch, maybeSummarizeConversation, summarizeOlderMessages } = require('../../src/services/gemini');

// ---------------------------------------------------------------------------
// detectEscalation(reply)
// ---------------------------------------------------------------------------
describe('detectEscalation', () => {
  it('returns the reason when reply contains [ESCALATE] with reason', () => {
    const result = detectEscalation('[ESCALATE] customer wants refund');
    assert.equal(result, 'customer wants refund');
  });

  it('returns default message when [ESCALATE] is alone with no reason', () => {
    const result = detectEscalation('[ESCALATE]');
    assert.equal(result, 'Customer needs human assistance');
  });

  it('returns null for normal reply text', () => {
    const result = detectEscalation('Hello, how can I help you today?');
    assert.equal(result, null);
  });

  it('returns null for empty string', () => {
    const result = detectEscalation('');
    assert.equal(result, null);
  });

  it('returns reason when [ESCALATE] appears in the middle of a reply', () => {
    const result = detectEscalation('Some prefix text [ESCALATE] customer is upset about billing');
    assert.equal(result, 'customer is upset about billing');
  });

  it('returns reason when [ESCALATE] is on a later line of a multiline reply', () => {
    const reply = 'I apologize for the inconvenience.\nLet me get someone to help.\n[ESCALATE] customer needs manager approval for discount';
    const result = detectEscalation(reply);
    assert.equal(result, 'customer needs manager approval for discount');
  });
});

// ---------------------------------------------------------------------------
// buildCustomerMemoryPrompt(facts)
// ---------------------------------------------------------------------------
describe('buildCustomerMemoryPrompt', () => {
  it('returns formatted prompt containing name, language, and notes', () => {
    const facts = {
      name: 'Alice',
      language: 'Hebrew',
      notes: ['interested in premium plan', 'prefers morning appointments'],
    };
    const result = buildCustomerMemoryPrompt(facts);
    assert.notEqual(result, null);
    assert.ok(result.includes('- Name: Alice'));
    assert.ok(result.includes('- Preferred language: Hebrew'));
    assert.ok(result.includes('- Key facts: interested in premium plan; prefers morning appointments'));
  });

  it('includes only name line when only name is provided', () => {
    const facts = { name: 'Bob' };
    const result = buildCustomerMemoryPrompt(facts);
    assert.notEqual(result, null);
    assert.ok(result.includes('- Name: Bob'));
    assert.ok(!result.includes('Preferred language'));
    assert.ok(!result.includes('Key facts'));
  });

  it('returns null for empty object', () => {
    const result = buildCustomerMemoryPrompt({});
    assert.equal(result, null);
  });

  it('returns null when notes is empty array and no name/language', () => {
    const result = buildCustomerMemoryPrompt({ notes: [] });
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// mergeFacts(existing, extracted)
// ---------------------------------------------------------------------------
describe('mergeFacts', () => {
  it('overwrites name when extracted has one', () => {
    const existing = { name: 'Alice', language: 'English', notes: [] };
    const extracted = { name: 'Bob', language: null, notes: [] };
    const result = mergeFacts(existing, extracted);
    assert.equal(result.name, 'Bob');
  });

  it('preserves existing name when extracted name is null', () => {
    const existing = { name: 'Alice', language: 'English', notes: [] };
    const extracted = { name: null, language: null, notes: [] };
    const result = mergeFacts(existing, extracted);
    assert.equal(result.name, 'Alice');
  });

  it('appends new notes and deduplicates case-insensitive', () => {
    const existing = { name: null, language: null, notes: ['Interested in premium plan'] };
    const extracted = { name: null, language: null, notes: ['interested in premium plan', 'wants refund'] };
    const result = mergeFacts(existing, extracted);
    assert.deepEqual(result.notes, ['Interested in premium plan', 'wants refund']);
  });

  it('caps notes at 20, keeping the last 20', () => {
    const existingNotes = Array.from({ length: 19 }, (_, i) => `note ${i + 1}`);
    const existing = { name: null, language: null, notes: existingNotes };
    const extracted = { name: null, language: null, notes: ['new note A', 'new note B'] };
    const result = mergeFacts(existing, extracted);
    assert.equal(result.notes.length, 20);
    // The first existing note should be dropped (slice(-20) keeps the last 20)
    assert.equal(result.notes[0], 'note 2');
    assert.equal(result.notes[18], 'new note A');
    assert.equal(result.notes[19], 'new note B');
  });

  it('handles empty existing and extracted gracefully', () => {
    const result = mergeFacts({}, { name: null, language: null, notes: [] });
    assert.deepEqual(result.notes, []);
    assert.equal(result.name, undefined);
    assert.equal(result.language, undefined);
  });

  it('handles missing notes arrays gracefully', () => {
    const result = mergeFacts({}, {});
    assert.deepEqual(result.notes, []);
  });
});

// ---------------------------------------------------------------------------
// summarizeConversation(business, history)
// ---------------------------------------------------------------------------
describe('summarizeConversation', () => {
  it('returns null for empty history', async () => {
    const result = await summarizeConversation(
      { id: 'biz-1', gemini_model: 'gemini-3-flash-preview' },
      []
    );
    assert.equal(result, null);
  });

  it('returns null for null history', async () => {
    const result = await summarizeConversation(
      { id: 'biz-1', gemini_model: 'gemini-3-flash-preview' },
      null
    );
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// detectHallucinatedBooking(reply)
// ---------------------------------------------------------------------------
describe('detectHallucinatedBooking', () => {
  it('detects Hebrew "נקבע בהצלחה" confirmation', () => {
    assert.equal(detectHallucinatedBooking('מעולה! התור נקבע בהצלחה ליום ראשון בשעה 10:00.'), true);
  });

  it('detects Hebrew "התור נקבע" confirmation', () => {
    assert.equal(detectHallucinatedBooking('התור נקבע ליום שלישי ב-14:00.'), true);
  });

  it('detects Hebrew "הוזמן בהצלחה" confirmation', () => {
    assert.equal(detectHallucinatedBooking('התור הוזמן בהצלחה!'), true);
  });

  it('detects Hebrew "שריינתי לך" confirmation', () => {
    assert.equal(detectHallucinatedBooking('שריינתי לך תור ליום רביעי.'), true);
  });

  it('detects Hebrew "הזמנתי לך" confirmation', () => {
    assert.equal(detectHallucinatedBooking('הזמנתי לך תור לתספורת מחר ב-09:00.'), true);
  });

  it('detects English "appointment has been confirmed" confirmation', () => {
    assert.equal(detectHallucinatedBooking('Great! Your appointment has been confirmed for Sunday at 10:00.'), true);
  });

  it('detects English "successfully booked your appointment" confirmation', () => {
    assert.equal(detectHallucinatedBooking('I have successfully booked your appointment for tomorrow at 2pm.'), true);
  });

  it('detects English "I\'ve booked" confirmation', () => {
    assert.equal(detectHallucinatedBooking("I've booked your haircut for Monday at 11:00."), true);
  });

  it('returns false for normal Hebrew reply', () => {
    assert.equal(detectHallucinatedBooking('שלום! איך אפשר לעזור לך היום?'), false);
  });

  it('returns false for availability response', () => {
    assert.equal(detectHallucinatedBooking('Here are the available slots for tomorrow: 09:00, 10:00, 11:00'), false);
  });

  it('returns false for null/undefined/empty', () => {
    assert.equal(detectHallucinatedBooking(null), false);
    assert.equal(detectHallucinatedBooking(undefined), false);
    assert.equal(detectHallucinatedBooking(''), false);
  });

  it('returns false for a question about booking', () => {
    assert.equal(detectHallucinatedBooking('Would you like me to book this appointment for you?'), false);
  });
});

// ---------------------------------------------------------------------------
// stripLeakedReasoning(reply)
// ---------------------------------------------------------------------------
describe('stripLeakedReasoning', () => {
  it('strips labeled THOUGHT: prefix before Hebrew text', () => {
    const result = stripLeakedReasoning('THOUGHT: The customer wants to book.\nשלום דניאל, איך אפשר לעזור?');
    assert.equal(result, 'שלום דניאל, איך אפשר לעזור?');
  });

  it('strips labeled THINKING: prefix (case-insensitive)', () => {
    const result = stripLeakedReasoning('thinking: I should help them.\nשלום');
    assert.equal(result, 'שלום');
  });

  it('strips unlabeled English reasoning before Hebrew text', () => {
    const result = stripLeakedReasoning('The booking failed because the slot was not found. I need to inform the customer.שלום דניאל');
    assert.equal(result, 'שלום דניאל');
  });

  it('strips unlabeled English reasoning before Arabic text', () => {
    const result = stripLeakedReasoning('The customer is asking about services. I should check availability.مرحبا، كيف يمكنني مساعدتك؟');
    assert.equal(result, 'مرحبا، كيف يمكنني مساعدتك؟');
  });

  it('does not strip clean Hebrew reply', () => {
    const input = 'שלום, איך אפשר לעזור?';
    assert.equal(stripLeakedReasoning(input), input);
  });

  it('does not strip clean English reply', () => {
    const input = 'Hello, how can I help you today?';
    assert.equal(stripLeakedReasoning(input), input);
  });

  it('does not strip short English text before Hebrew (not reasoning)', () => {
    const input = 'OK! שלום דניאל';
    assert.equal(stripLeakedReasoning(input), input);
  });

  it('returns empty string for null/undefined', () => {
    assert.equal(stripLeakedReasoning(null), null);
    assert.equal(stripLeakedReasoning(undefined), undefined);
    assert.equal(stripLeakedReasoning(''), '');
  });

  it('strips combined labeled prefix + unlabeled reasoning', () => {
    const result = stripLeakedReasoning('INTERNAL: Since the slot expired, I need to suggest alternatives.אין בעיה, בוא נבדוק שוב');
    assert.equal(result, 'אין בעיה, בוא נבדוק שוב');
  });
});

// ---------------------------------------------------------------------------
// summarizeOlderMessages
// ---------------------------------------------------------------------------
describe('summarizeOlderMessages', () => {
  it('returns null for empty messages array', async () => {
    const result = await summarizeOlderMessages(
      { id: 'biz-1', gemini_model: 'gemini-3-flash-preview' },
      [],
      null
    );
    assert.equal(result, null);
  });

  it('returns null for null messages', async () => {
    const result = await summarizeOlderMessages(
      { id: 'biz-1', gemini_model: 'gemini-3-flash-preview' },
      null,
      null
    );
    assert.equal(result, null);
  });

  it('returns existing summary when messages are empty and existingSummary is set', async () => {
    const result = await summarizeOlderMessages(
      { id: 'biz-1', gemini_model: 'gemini-3-flash-preview' },
      [],
      'Previous summary text'
    );
    assert.equal(result, 'Previous summary text');
  });

  it('returns existing summary when messages are null and existingSummary is set', async () => {
    const result = await summarizeOlderMessages(
      { id: 'biz-1', gemini_model: 'gemini-3-flash-preview' },
      null,
      'Previous summary text'
    );
    assert.equal(result, 'Previous summary text');
  });
});

// ---------------------------------------------------------------------------
// maybeSummarizeConversation
// ---------------------------------------------------------------------------
describe('maybeSummarizeConversation', () => {
  it('returns early when messages are null', async () => {
    // Should not throw
    await maybeSummarizeConversation(
      { id: 'biz-1', gemini_model: 'gemini-3-flash-preview' },
      '972501111111',
      null
    );
  });

  it('returns early when messages count is below threshold', async () => {
    const origThreshold = config.conversationSummaryThreshold;
    config.conversationSummaryThreshold = 20;
    try {
      const messages = Array.from({ length: 19 }, (_, i) => ({ role: 'user', content: `msg ${i}` }));
      // Should not throw or do anything
      await maybeSummarizeConversation(
        { id: 'biz-1', gemini_model: 'gemini-3-flash-preview' },
        '972501111111',
        messages
      );
    } finally {
      config.conversationSummaryThreshold = origThreshold;
    }
  });

  it('returns early when messages count equals threshold but all are recent', async () => {
    const origThreshold = config.conversationSummaryThreshold;
    const origRecent = config.conversationRecentMessages;
    config.conversationSummaryThreshold = 5;
    config.conversationRecentMessages = 5;
    try {
      const messages = Array.from({ length: 5 }, (_, i) => ({ role: 'user', content: `msg ${i}` }));
      // olderMessages would be empty since all 5 messages are "recent"
      await maybeSummarizeConversation(
        { id: 'biz-1', gemini_model: 'gemini-3-flash-preview' },
        '972501111111',
        messages
      );
    } finally {
      config.conversationSummaryThreshold = origThreshold;
      config.conversationRecentMessages = origRecent;
    }
  });
});

// ---------------------------------------------------------------------------
// detectBookingTimeMismatch(reply, bookingResult)
// ---------------------------------------------------------------------------
describe('detectBookingTimeMismatch', () => {
  const bookingResult = {
    success: true,
    start_time: '2099-01-01T10:00:00Z',
    end_time: '2099-01-01T10:30:00Z',
    formatted_start_time: '12:00',
    formatted_end_time: '12:30',
    service_name: 'Haircut',
    customer_name: 'Alice',
  };

  it('returns null when reply mentions correct booked time', () => {
    const reply = 'Your appointment has been confirmed for 12:00. See you then!';
    assert.equal(detectBookingTimeMismatch(reply, bookingResult), null);
  });

  it('returns null when reply mentions both start and end time correctly', () => {
    const reply = 'I\'ve booked your appointment from 12:00 to 12:30.';
    assert.equal(detectBookingTimeMismatch(reply, bookingResult), null);
  });

  it('returns mismatched time when reply mentions wrong time', () => {
    const reply = 'Your appointment has been confirmed for 15:00. See you then!';
    const mismatch = detectBookingTimeMismatch(reply, bookingResult);
    assert.equal(mismatch, '15:00');
  });

  it('returns null when reply has no time patterns', () => {
    const reply = 'Your appointment has been confirmed. See you then!';
    assert.equal(detectBookingTimeMismatch(reply, bookingResult), null);
  });

  it('returns null when reply is not a booking confirmation', () => {
    const reply = 'The next available slot is at 15:00.';
    assert.equal(detectBookingTimeMismatch(reply, bookingResult), null);
  });

  it('returns null when bookingResult has no formatted_start_time', () => {
    const reply = 'Your appointment has been confirmed for 15:00.';
    assert.equal(detectBookingTimeMismatch(reply, { success: true }), null);
  });

  it('returns null for null/empty inputs', () => {
    assert.equal(detectBookingTimeMismatch(null, bookingResult), null);
    assert.equal(detectBookingTimeMismatch('', bookingResult), null);
    assert.equal(detectBookingTimeMismatch('text', null), null);
  });
});
