// Controls and invisible formatting must not hide or reorder readable text.
export const TEXT_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff\p{Default_Ignorable_Code_Point}]/gu;
