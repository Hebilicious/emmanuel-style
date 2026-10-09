//! JavaScript object semantics for the artifact IR.
//!
//! Every `Record<string, T>` in the TypeScript IR is a JavaScript object, and the
//! emitted bytes depend on the order its keys are visited in. That order is not
//! insertion order for integer-like keys: an object literal / assignment puts
//! array-index keys (`"0"`, `"1"`, …) first, in ascending numeric order, and the
//! remaining keys after them in insertion order. The emitter and the manifest
//! writer iterate some of these records without sorting them, so the port has to
//! reproduce that rule exactly or the bytes drift on a document whose input
//! defaults or selection keys look numeric.
//!
//! [`JsObject`] does that: `iter()` and `keys()` yield JavaScript's own-key order,
//! `insert` keeps the last value for a repeated key while keeping the key's
//! original position (JavaScript assignment semantics).

use std::collections::HashMap;

use serde::de::{MapAccess, Visitor};
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// True for a string that JavaScript treats as an array index key: a canonical
/// unsigned 32-bit integer below `2^32 - 1`.
fn is_index_key(key: &str) -> bool {
    let bytes = key.as_bytes();
    if bytes.is_empty() || bytes.len() > 10 {
        return false;
    }
    if bytes[0] == b'0' && bytes.len() > 1 {
        return false;
    }
    if !bytes.iter().all(u8::is_ascii_digit) {
        return false;
    }
    !(bytes.len() == 10 && key >= "4294967295")
}

/// An insertion-ordered map with JavaScript object key ordering.
#[derive(Clone, Debug)]
pub struct JsObject<V> {
    entries: Vec<(String, V)>,
    index: HashMap<String, usize>,
}

impl<V> Default for JsObject<V> {
    fn default() -> Self {
        Self::new()
    }
}

impl<V> JsObject<V> {
    /// An empty map.
    pub fn new() -> Self {
        Self { entries: Vec::new(), index: HashMap::new() }
    }

    /// Number of keys.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// True when no key is present.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The stored value for `key`.
    pub fn get(&self, key: &str) -> Option<&V> {
        self.index.get(key).map(|position| &self.entries[*position].1)
    }

    /// True when `key` is present.
    pub fn contains_key(&self, key: &str) -> bool {
        self.index.contains_key(key)
    }

    /// Assigns `key`, keeping an existing key's position (JavaScript semantics).
    pub fn insert(&mut self, key: impl Into<String>, value: V) {
        let key = key.into();
        if let Some(position) = self.index.get(&key) {
            self.entries[*position].1 = value;
            return;
        }
        self.index.insert(key.clone(), self.entries.len());
        self.entries.push((key, value));
    }

    /// Every key in JavaScript own-key order: index keys ascending, then the rest
    /// in insertion order.
    pub fn keys(&self) -> Vec<&str> {
        let mut indices: Vec<&(String, V)> =
            self.entries.iter().filter(|(key, _)| is_index_key(key)).collect();
        indices.sort_by(|a, b| {
            a.0.parse::<u64>().unwrap_or(0).cmp(&b.0.parse::<u64>().unwrap_or(0))
        });
        let rest = self.entries.iter().filter(|(key, _)| !is_index_key(key));
        indices
            .into_iter()
            .chain(rest)
            .map(|(key, _)| key.as_str())
            .collect()
    }

    /// Every entry in JavaScript own-key order.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &V)> {
        self.keys().into_iter().map(move |key| (key, self.get(key).expect("key present")))
    }

    /// Every value in JavaScript own-key order.
    pub fn values(&self) -> impl Iterator<Item = &V> {
        self.iter().map(|(_, value)| value)
    }

    /// Every entry in insertion order, without reordering.
    pub fn insertion_order(&self) -> impl Iterator<Item = (&str, &V)> {
        self.entries.iter().map(|(key, value)| (key.as_str(), value))
    }

    /// Builds from an iterator of pairs, later duplicates winning in place.
    pub fn from_pairs(pairs: impl IntoIterator<Item = (String, V)>) -> Self {
        let mut object = Self::new();
        for (key, value) in pairs {
            object.insert(key, value);
        }
        object
    }
}

impl<V: PartialEq> PartialEq for JsObject<V> {
    /// Equality is order-insensitive, like a plain record comparison would be if
    /// it compared key sets; the ported code never compares two records for order.
    fn eq(&self, other: &Self) -> bool {
        if self.len() != other.len() {
            return false;
        }
        self.entries.iter().all(|(key, value)| other.get(key) == Some(value))
    }
}

impl<V: Eq> Eq for JsObject<V> {}

impl<V: Serialize> Serialize for JsObject<V> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.len()))?;
        for (key, value) in self.iter() {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}

impl<'de, V: Deserialize<'de>> Deserialize<'de> for JsObject<V> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ObjectVisitor<V>(std::marker::PhantomData<V>);

        impl<'de, V: Deserialize<'de>> Visitor<'de> for ObjectVisitor<V> {
            type Value = JsObject<V>;

            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a map")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut access: A) -> Result<Self::Value, A::Error> {
                let mut object = JsObject::new();
                while let Some((key, value)) = access.next_entry::<String, V>()? {
                    object.insert(key, value);
                }
                Ok(object)
            }
        }

        deserializer.deserialize_map(ObjectVisitor(std::marker::PhantomData))
    }
}

/// Deserializes a value that may be absent as an empty map.
pub fn de_object<'de, D, V>(deserializer: D) -> Result<JsObject<V>, D::Error>
where
    D: Deserializer<'de>,
    V: Deserialize<'de>,
{
    let value = Option::<JsObject<V>>::deserialize(deserializer)?;
    Ok(value.unwrap_or_default())
}
