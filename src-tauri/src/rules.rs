// Rule evaluation for newly-ingested items.
//
// `filter_type_mask` bit layout (i64):
//   bit 0 (1) = match against item title
//   bit 1 (2) = match against item snippet
//   bit 2 (4) = match against item creator
// Mask 0 means "no fields selected" -> rule never matches.
// Multiple bits OR together -- a rule with mask 3 fires if EITHER title
// OR snippet contains `filter_search` (case-insensitive substring).
//
// `action_*` fields on a SourceRule are `Option<i64>` where:
//   None    -> rule doesn't touch this field on a matching item
//   Some(0) -> rule sets the field to false
//   Some(_) -> rule sets the field to true

use crate::models::{NewItem, SourceRule};

pub const MASK_TITLE: i64 = 1;
pub const MASK_SNIPPET: i64 = 2;
pub const MASK_CREATOR: i64 = 4;

#[derive(Debug, Clone, Copy)]
pub struct RuleAction {
    pub has_read: Option<bool>,
    pub starred: Option<bool>,
    pub hidden: Option<bool>,
    pub notify: Option<bool>,
}

fn to_bool(v: Option<i64>) -> Option<bool> {
    v.map(|n| n != 0)
}

pub fn evaluate(rule: &SourceRule, item: &NewItem) -> Option<RuleAction> {
    if rule.filter_type_mask == 0 {
        return None;
    }
    let needle = rule.filter_search.to_lowercase();
    let mut matched = false;
    if rule.filter_type_mask & MASK_TITLE != 0
        && item.title.to_lowercase().contains(&needle)
    {
        matched = true;
    }
    if !matched && rule.filter_type_mask & MASK_SNIPPET != 0 {
        if let Some(s) = &item.snippet {
            if s.to_lowercase().contains(&needle) {
                matched = true;
            }
        }
    }
    if !matched && rule.filter_type_mask & MASK_CREATOR != 0 {
        if let Some(c) = &item.creator {
            if c.to_lowercase().contains(&needle) {
                matched = true;
            }
        }
    }
    if !rule.filter_match {
        matched = !matched;
    }
    if !matched {
        return None;
    }
    Some(RuleAction {
        has_read: to_bool(rule.action_read),
        starred: to_bool(rule.action_star),
        hidden: to_bool(rule.action_hide),
        notify: to_bool(rule.action_notify),
    })
}

pub fn apply_all(rules: &[SourceRule], items: &mut [NewItem]) {
    if rules.is_empty() {
        return;
    }
    let mut ordered: Vec<&SourceRule> = rules.iter().collect();
    ordered.sort_by_key(|r| r.position);
    for rule in ordered {
        for item in items.iter_mut() {
            if let Some(act) = evaluate(rule, item) {
                if let Some(v) = act.has_read {
                    item.has_read = v;
                }
                if let Some(v) = act.starred {
                    item.starred = v;
                }
                if let Some(v) = act.hidden {
                    item.hidden = v;
                }
                if let Some(v) = act.notify {
                    item.notify = v;
                }
            }
        }
    }
}
