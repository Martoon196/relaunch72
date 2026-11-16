<?php
// Isolated focus-phrase regression (1.2.0): no WordPress install. Run once per SEO plugin:
//   php focus-phrase-test.php yoast   |   php focus-phrase-test.php rank_math   |   php focus-phrase-test.php standalone
define( 'ABSPATH', __DIR__ );
$mode = $argv[1] ?? 'yoast';
if ( 'yoast' === $mode ) { define( 'WPSEO_VERSION', '23.0' ); }
if ( 'rank_math' === $mode ) { define( 'RANK_MATH_VERSION', '1.0.230' ); }
$GLOBALS['meta'] = array();
function sanitize_text_field( $s ) { return trim( preg_replace( '/[\r\n\t ]+/', ' ', strip_tags( (string) $s ) ) ); }
function wp_http_validate_url( $u ) { return 0 === strpos( (string) $u, 'https://' ) ? $u : false; }
function esc_url_raw( $u ) { return $u; }
function wp_json_encode( $v ) { return json_encode( $v ); }
function wp_slash( $v ) { return $v; }
function __( $s ) { return $s; }
function get_post_meta( $id, $k, $single ) { return $GLOBALS['meta'][ $id ][ $k ] ?? ''; }
function update_post_meta( $id, $k, $v ) { $GLOBALS['meta'][ $id ][ $k ] = $v; return true; }
function delete_post_meta( $id, $k ) { unset( $GLOBALS['meta'][ $id ][ $k ] ); return true; }
class R72Pub_Settings { public static function get() { return array( 'seo_mode' => 'auto' ); } }
require __DIR__ . '/../relaunch72-publisher/includes/class-r72pub-seo.php';
function check( $ok, $what ) { if ( ! $ok ) { throw new Exception( $what ); } }
$field = array( 'yoast' => '_yoast_wpseo_focuskw', 'rank_math' => 'rank_math_focus_keyword', 'standalone' => null )[ $mode ];
$base = array( 'seoTitle' => 'Tenancy deposit protection: a guide', 'metaDescription' => 'How to protect a deposit.', 'wordpress' => array( 'robots' => array( 'index' => true, 'follow' => true ) ) );
$with = $base; $with['wordpress']['seo'] = array( 'focusPhrase' => " tenancy  deposit, protection <b>x</b>", 'secondaryPhrases' => array( 'deposit protection deadline', 'return tenancy deposit', 'a', 'b', 'c', 'deposit protection deadline' ) );

// 1. An older payload (no phrase) never writes or clears a focus phrase.
update_post_meta( 7, '_yoast_wpseo_focuskw', 'set by a person' ); update_post_meta( 7, 'rank_math_focus_keyword', 'set by a person' );
$r = R72Pub_Seo::apply( 7, R72Pub_Seo::intent_from_payload( $base, 'https://x.example/a' ), 0, '' );
check( 'set by a person' === get_post_meta( 7, '_yoast_wpseo_focuskw', true ) && 'set by a person' === get_post_meta( 7, 'rank_math_focus_keyword', true ), 'An older payload touched a focus phrase' );
check( ! in_array( (string) $field, array_merge( $r['written'], $r['preserved'] ), true ), 'An older payload listed the focus field' );

// 2. With a phrase: written into the active plugin's own field, cleaned; Rank Math gets up to four more, comma-separated.
$intent = R72Pub_Seo::intent_from_payload( $with, 'https://x.example/a' );
check( 'tenancy deposit protection x' === $intent['focusPhrase'], 'Phrase not cleaned: ' . $intent['focusPhrase'] );
check( array( 'deposit protection deadline', 'return tenancy deposit', 'a', 'b' ) === $intent['secondaryPhrases'], 'Secondary phrases not capped or de-duplicated' );
$r = R72Pub_Seo::apply( 8, $intent, 0, '' );
if ( 'yoast' === $mode ) { check( 'tenancy deposit protection x' === get_post_meta( 8, '_yoast_wpseo_focuskw', true ), 'Yoast focus keyphrase not written' ); }
if ( 'rank_math' === $mode ) { check( 'tenancy deposit protection x,deposit protection deadline,return tenancy deposit,a,b' === get_post_meta( 8, 'rank_math_focus_keyword', true ), 'Rank Math focus keywords not written' ); }
if ( 'standalone' === $mode ) { check( '' === get_post_meta( 8, '_yoast_wpseo_focuskw', true ) && '' === get_post_meta( 8, 'rank_math_focus_keyword', true ), 'Standalone wrote another plugin\'s field' ); }
if ( $field ) { check( in_array( $field, $r['written'], true ), 'Focus field not reported as written' ); }

// 3. Same rule as every other field: a person's later change is kept on the next update.
if ( $field ) {
	update_post_meta( 8, $field, 'changed by a person' );
	$again = $with; $again['wordpress']['seo']['focusPhrase'] = 'a newer phrase';
	$r = R72Pub_Seo::apply( 8, R72Pub_Seo::intent_from_payload( $again, 'https://x.example/a' ), 0, '' );
	check( 'changed by a person' === get_post_meta( 8, $field, true ), 'A person\'s focus phrase was overwritten' );
	check( in_array( $field, $r['preserved'], true ), 'The kept focus field was not reported as preserved' );
	// Untouched by a person: a newer phrase replaces ours.
	$r = R72Pub_Seo::apply( 9, R72Pub_Seo::intent_from_payload( $with, 'https://x.example/a' ), 0, '' );
	$r = R72Pub_Seo::apply( 9, R72Pub_Seo::intent_from_payload( $again, 'https://x.example/a' ), 0, '' );
	check( 0 === strpos( (string) get_post_meta( 9, $field, true ), 'a newer phrase' ), 'Our own earlier phrase was not updated' );
}
echo "Focus phrase ($mode): written only when sent, cleaned, kept when a person changed it.\n";
