use crate::TagVocabularyEntry;
use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct TagVocabularyCategory {
    pub name: &'static str,
    pub entries: Vec<TagVocabularyEntry>,
}

pub type TagVocabularySeed = (&'static str, &'static [&'static str]);

pub fn build_tag_vocabulary_entries(
    seeds: &[TagVocabularySeed],
) -> Result<Vec<TagVocabularyEntry>> {
    seeds.iter()
        .map(|(label, variants)| TagVocabularyEntry::with_variants(*label, *variants))
        .collect()
}

pub fn photo_search_vocabulary() -> Result<Vec<TagVocabularyEntry>> {
    Ok(photo_search_vocabulary_categories()?
        .into_iter()
        .flat_map(|category| category.entries)
        .collect())
}

pub fn photo_auto_tag_vocabulary() -> Result<Vec<TagVocabularyEntry>> {
    let vocabulary = photo_search_vocabulary()?;
    let labels = [
        "person",
        "portrait",
        "group photo",
        "family",
        "child",
        "baby",
        "dog",
        "cat",
        "bird",
        "wildlife",
        "interior",
        "exterior",
        "office",
        "library",
        "church interior",
        "chapel interior",
        "landscape",
        "beach",
        "forest",
        "mountain",
        "sunset",
        "snow scene",
        "cityscape",
        "street scene",
        "window",
        "stained glass window",
        "table",
        "desk",
        "open book",
        "notebook",
        "car",
        "bicycle",
        "coffee",
        "sunlight",
        "black and white",
        "vintage",
    ];
    Ok(vocabulary
        .into_iter()
        .filter(|entry| labels.contains(&entry.label.as_str()))
        .collect())
}

pub fn photo_search_vocabulary_categories() -> Result<Vec<TagVocabularyCategory>> {
    Ok(vec![
        TagVocabularyCategory {
            name: "people",
            entries: photo_search_people_vocabulary()?,
        },
        TagVocabularyCategory {
            name: "animals",
            entries: photo_search_animal_vocabulary()?,
        },
        TagVocabularyCategory {
            name: "places",
            entries: photo_search_place_vocabulary()?,
        },
        TagVocabularyCategory {
            name: "nature",
            entries: photo_search_nature_vocabulary()?,
        },
        TagVocabularyCategory {
            name: "architecture",
            entries: photo_search_architecture_vocabulary()?,
        },
        TagVocabularyCategory {
            name: "travel",
            entries: photo_search_travel_vocabulary()?,
        },
        TagVocabularyCategory {
            name: "objects",
            entries: photo_search_object_vocabulary()?,
        },
        TagVocabularyCategory {
            name: "food",
            entries: photo_search_food_vocabulary()?,
        },
        TagVocabularyCategory {
            name: "light",
            entries: photo_search_light_vocabulary()?,
        },
        TagVocabularyCategory {
            name: "style",
            entries: photo_search_style_vocabulary()?,
        },
    ])
}

pub fn photo_search_people_vocabulary() -> Result<Vec<TagVocabularyEntry>> {
    build_tag_vocabulary_entries(&[
        ("person", &["human", "single person"]),
        ("portrait", &["portrait photo", "person portrait"]),
        ("self portrait", &["selfie", "mirror selfie"]),
        ("group photo", &["group portrait", "people together"]),
        ("family", &["family portrait", "family photo"]),
        ("couple", &["two people", "romantic couple"]),
        ("child", &["young child", "kid"]),
        ("baby", &["infant", "newborn"]),
        ("bride", &["wedding bride"]),
        ("groom", &["wedding groom"]),
        ("crowd", &["large group of people"]),
        ("dancer", &["dance performance"]),
        ("musician", &["person playing music"]),
        ("athlete", &["sports person", "sports portrait"]),
        ("worker", &["person at work"]),
        ("chef", &["person cooking"]),
        ("artist", &["creative portrait"]),
        ("traveler", &["travel portrait"]),
    ])
}

pub fn photo_search_animal_vocabulary() -> Result<Vec<TagVocabularyEntry>> {
    build_tag_vocabulary_entries(&[
        ("dog", &["pet dog", "canine"]),
        ("cat", &["pet cat", "feline"]),
        ("horse", &["riding horse"]),
        ("bird", &["flying bird"]),
        ("fish", &["aquarium fish"]),
        ("butterfly", &["colorful butterfly"]),
        ("bee", &["honey bee"]),
        ("deer", &["wild deer"]),
        ("cow", &["farm cow"]),
        ("sheep", &["farm sheep"]),
        ("wildlife", &["wild animal"]),
        ("pet", &["domestic animal"]),
    ])
}

pub fn photo_search_place_vocabulary() -> Result<Vec<TagVocabularyEntry>> {
    build_tag_vocabulary_entries(&[
        ("interior", &["inside a building"]),
        ("exterior", &["outside a building"]),
        ("living room", &["home interior living room"]),
        ("bedroom", &["home interior bedroom"]),
        ("kitchen", &["home interior kitchen"]),
        ("dining room", &["home interior dining room"]),
        ("bathroom", &["home interior bathroom"]),
        ("office", &["workspace interior", "office interior"]),
        ("studio", &["artist studio", "photo studio"]),
        ("classroom", &["school classroom"]),
        ("library", &["library interior", "reading room"]),
        ("cafe", &["coffee shop", "cafe interior"]),
        ("restaurant", &["restaurant interior", "dining space"]),
        ("bar", &["bar interior", "pub interior"]),
        ("hotel room", &["hotel interior"]),
        ("shop", &["store interior", "retail shop"]),
        ("market", &["market stall", "street market"]),
        ("church interior", &["church inside", "inside a church"]),
        ("chapel interior", &["chapel inside", "inside a chapel"]),
        ("museum interior", &["museum gallery", "gallery interior"]),
    ])
}

pub fn photo_search_nature_vocabulary() -> Result<Vec<TagVocabularyEntry>> {
    build_tag_vocabulary_entries(&[
        ("landscape", &["scenic landscape", "wide landscape"]),
        ("seascape", &["coastal scene", "ocean view"]),
        ("beach", &["sandy beach"]),
        ("coastline", &["rocky coast", "coastal view"]),
        ("ocean", &["open sea"]),
        ("lake", &["lake view"]),
        ("river", &["river landscape"]),
        ("waterfall", &["cascading waterfall"]),
        ("forest", &["forest landscape", "woods"]),
        ("woodland path", &["forest path"]),
        ("garden", &["flower garden"]),
        ("park", &["city park"]),
        ("mountain", &["mountain landscape"]),
        ("hill", &["rolling hills"]),
        ("desert", &["desert landscape"]),
        ("snow scene", &["snowy landscape", "winter scene"]),
        ("sunrise", &["early morning sky"]),
        ("sunset", &["evening sky"]),
        ("night sky", &["stars in the sky", "starry sky"]),
    ])
}

pub fn photo_search_architecture_vocabulary() -> Result<Vec<TagVocabularyEntry>> {
    build_tag_vocabulary_entries(&[
        ("cityscape", &["urban skyline", "city view"]),
        ("street scene", &["city street", "urban street"]),
        ("alley", &["narrow street"]),
        ("bridge", &["bridge over water"]),
        ("tower", &["tall tower"]),
        ("castle", &["historic castle"]),
        ("ruin", &["historic ruins", "ancient ruin"]),
        ("house exterior", &["house outside", "residential house"]),
        ("apartment building", &["residential building"]),
        ("doorway", &["arched doorway", "front door"]),
        ("staircase", &["interior stairs"]),
        ("corridor", &["hallway", "interior corridor"]),
        ("window", &["large window"]),
        ("stained glass window", &["church window", "ornate window"]),
        ("balcony", &["building balcony"]),
        ("rooftop", &["roof terrace"]),
    ])
}

pub fn photo_search_travel_vocabulary() -> Result<Vec<TagVocabularyEntry>> {
    build_tag_vocabulary_entries(&[
        ("car", &["parked car"]),
        ("bicycle", &["bike"]),
        ("motorcycle", &["motorbike"]),
        ("train", &["railway train"]),
        ("tram", &["street tram"]),
        ("bus", &["city bus"]),
        ("airplane", &["aircraft", "passenger plane"]),
        ("boat", &["small boat"]),
        ("ship", &["large ship"]),
        ("harbor", &["port", "marina"]),
        ("station", &["train station", "platform"]),
        ("airport", &["airport terminal"]),
    ])
}

pub fn photo_search_object_vocabulary() -> Result<Vec<TagVocabularyEntry>> {
    build_tag_vocabulary_entries(&[
        ("table", &["tabletop"]),
        ("wooden table", &["wood table", "timber table"]),
        ("desk", &["work desk"]),
        ("writing desk", &["desk for writing"]),
        ("chair", &["wooden chair"]),
        ("armchair", &["lounge chair"]),
        ("sofa", &["couch"]),
        ("bed", &["made bed"]),
        ("bookshelf", &["book shelf", "shelf with books"]),
        ("lamp", &["table lamp", "floor lamp"]),
        ("candle", &["lit candle"]),
        ("vase", &["flower vase"]),
        ("mirror", &["wall mirror"]),
        ("clock", &["wall clock"]),
        ("camera", &["photo camera"]),
        ("laptop", &["open laptop"]),
        ("phone", &["mobile phone", "smartphone"]),
        ("cup", &["coffee cup", "tea cup"]),
        ("plate", &["dinner plate"]),
        ("bottle", &["glass bottle"]),
        ("glass", &["drinking glass"]),
        ("open book", &["book on table", "opened book"]),
        ("notebook", &["paper notebook", "notebook on table"]),
        ("handwriting", &["written notes", "handwritten page"]),
        ("flower arrangement", &["flowers in a vase"]),
    ])
}

pub fn photo_search_food_vocabulary() -> Result<Vec<TagVocabularyEntry>> {
    build_tag_vocabulary_entries(&[
        ("meal", &["plated meal"]),
        ("breakfast", &["breakfast table"]),
        ("coffee", &["cup of coffee"]),
        ("tea", &["cup of tea"]),
        ("dessert", &["sweet dessert"]),
        ("bread", &["fresh bread"]),
        ("fruit", &["fresh fruit"]),
        ("cake", &["slice of cake"]),
    ])
}

pub fn photo_search_light_vocabulary() -> Result<Vec<TagVocabularyEntry>> {
    build_tag_vocabulary_entries(&[
        ("backlit scene", &["strong backlight", "backlit photo"]),
        ("silhouette", &["silhouetted subject"]),
        ("reflection", &["reflective surface"]),
        ("shadow", &["strong shadow"]),
        ("sunlight", &["bright sunlight"]),
        ("sunlit interior", &["light streaming through window"]),
        ("golden hour", &["warm evening light"]),
        ("low light", &["dim light"]),
        ("close up", &["detail shot"]),
        ("macro photo", &["macro photography"]),
        ("wide shot", &["wide angle scene"]),
        ("symmetry", &["symmetrical composition"]),
        ("texture", &["textured surface"]),
        ("abstract pattern", &["pattern detail"]),
    ])
}

pub fn photo_search_style_vocabulary() -> Result<Vec<TagVocabularyEntry>> {
    build_tag_vocabulary_entries(&[
        ("documentary photo", &["documentary photography"]),
        ("travel photo", &["travel photography"]),
        ("street photography", &["street photo"]),
        ("fine art photo", &["fine art photography"]),
        ("black and white", &["monochrome photo", "grayscale image"]),
        ("vintage", &["retro style", "old fashioned"]),
        ("minimal", &["minimalist photo"]),
        ("dramatic", &["dramatic lighting"]),
        ("cozy", &["warm cozy interior"]),
        ("moody", &["moody atmosphere"]),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_photo_search_vocabulary() {
        let vocabulary = photo_search_vocabulary().expect("vocabulary");
        assert!(vocabulary.len() > 100);
        assert!(vocabulary
            .iter()
            .any(|entry| entry.label == "stained glass window"));
        assert!(vocabulary.iter().any(|entry| entry.label == "open book"));
        assert!(vocabulary
            .iter()
            .any(|entry| entry.label == "church interior"));
    }

    #[test]
    fn builds_category_list() {
        let categories = photo_search_vocabulary_categories().expect("categories");
        assert_eq!(categories.len(), 10);
        assert!(categories.iter().any(|category| category.name == "objects"));
        assert!(categories.iter().any(|category| category.name == "light"));
    }

    #[test]
    fn builds_auto_tag_vocabulary() {
        let vocabulary = photo_auto_tag_vocabulary().expect("vocabulary");
        assert!(vocabulary.len() >= 30);
        assert!(vocabulary
            .iter()
            .any(|entry| entry.label == "stained glass window"));
        assert!(vocabulary.iter().any(|entry| entry.label == "open book"));
        assert!(vocabulary.iter().any(|entry| entry.label == "person"));
    }
}
