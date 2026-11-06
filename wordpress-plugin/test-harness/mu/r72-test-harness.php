<?php
/**
 * DISPOSABLE TEST HARNESS ONLY. Never install on a real site.
 * - Serves the fixture hero image for Relaunch72 media URLs without network access.
 * - Exposes a token-protected control route used by the Node test driver to simulate
 *   human edits and site configuration changes.
 */
if ( ! defined( 'R72_TEST_TOKEN' ) ) { return; }
remove_action( 'template_redirect', 'redirect_canonical' );
add_filter( 'pre_http_request', function ( $pre, $args, $url ) {
	$prefix = 'https://app.relaunch72.com/api/public/seo-blog/media/';
	if ( 0 !== strpos( $url, $prefix ) && 0 !== strpos( $url, 'https://evil.example/' ) ) { return $pre; }
	if ( false !== strpos( $url, '/redirect/' ) ) { return array( 'headers' => array( 'location' => 'https://evil.example/x.png' ), 'body' => '', 'response' => array( 'code' => 302, 'message' => 'Found' ), 'cookies' => array(), 'filename' => null ); }
	if ( false !== strpos( $url, '/down/' ) ) { return new WP_Error( 'http_request_failed', 'simulated timeout' ); }
	$bytes = file_get_contents( '/r72-fixtures/hero.png' );
	if ( false !== strpos( $url, '/tamper/' ) ) { $bytes .= 'x'; }
	update_option( 'r72test_media_fetches', (int) get_option( 'r72test_media_fetches', 0 ) + 1 );
	return array( 'headers' => array( 'content-type' => 'image/png' ), 'body' => $bytes, 'response' => array( 'code' => 200, 'message' => 'OK' ), 'cookies' => array(), 'filename' => null );
}, 10, 3 );
add_action( 'rest_api_init', function () {
	register_rest_route( 'r72test/v1', '/do', array( 'methods' => 'POST', 'permission_callback' => function ( $r ) { return hash_equals( R72_TEST_TOKEN, (string) $r->get_header( 'x_test_token' ) ); }, 'callback' => function ( $r ) {
		$a = $r->get_json_params();
		switch ( $a['op'] ) {
			case 'option': update_option( $a['name'], $a['value'] ); if ( 'permalink_structure' === $a['name'] || 'category_base' === $a['name'] ) { delete_option( 'rewrite_rules' ); } return array( 'ok' => true );
			case 'settings': R72Pub_Settings::update( $a['value'] ); return R72Pub_Settings::get();
			case 'rotate': return array( 'secret' => R72Pub_Settings::rotate_secret() );
			case 'plugins': require_once ABSPATH . 'wp-admin/includes/plugin.php'; foreach ( (array) ( $a['deactivate'] ?? array() ) as $p ) { deactivate_plugins( $p, true ); } foreach ( (array) ( $a['activate'] ?? array() ) as $p ) { if ( is_plugin_active( $p ) ) { deactivate_plugins( $p, true ); } $res = activate_plugin( $p, '', false, false ); if ( 'seo-by-rank-math/rank-math.php' === $p ) { update_option( 'rank_math_registration_skip', 1 ); update_option( 'rank_math_wizard_completed', 1 ); delete_option( 'rewrite_rules' ); } if ( is_wp_error( $res ) ) { return array( 'error' => $res->get_error_message() ); } } return array( 'active' => get_option( 'active_plugins' ) );
			case 'human_edit': wp_set_current_user( 1 ); wp_update_post( array( 'ID' => (int) $a['post'], $a['field'] => $a['value'] ) ); return array( 'ok' => true );
			case 'human_meta': update_post_meta( (int) $a['post'], $a['key'], $a['value'] ); return array( 'ok' => true );
			case 'human_post': wp_set_current_user( 1 ); return array( 'id' => wp_insert_post( array( 'post_title' => $a['title'], 'post_name' => $a['slug'], 'post_status' => 'publish', 'post_type' => 'post', 'post_content' => 'Human post' ) ) );
			case 'post': $id = (int) $a['post']; $meta = array(); foreach ( get_post_meta( $id ) as $k => $v ) { $meta[ $k ] = maybe_unserialize( $v[0] ); } return array( 'post' => get_post( $id ), 'meta' => $meta, 'permalink' => get_permalink( $id ), 'cats' => wp_get_post_categories( $id, array( 'fields' => 'slugs' ) ), 'thumb' => (int) get_post_thumbnail_id( $id ) );
			case 'count': global $wpdb; return array( 'posts' => (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->posts} WHERE post_type='post' AND post_status<>'auto-draft'" ), 'attachments' => (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->posts} WHERE post_type='attachment'" ), 'mediaFetches' => (int) get_option( 'r72test_media_fetches', 0 ), 'managed' => (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->postmeta} WHERE meta_key='_r72_article_id'" ) );
			case 'caps': return array( 'eval' => R72Pub_Capabilities::evaluate(), 'caps' => R72Pub_Capabilities::capabilities() );
			case 'uninstall': require_once ABSPATH . 'wp-admin/includes/plugin.php'; deactivate_plugins( 'relaunch72-publisher/relaunch72-publisher.php', true ); define( 'WP_UNINSTALL_PLUGIN', 'relaunch72-publisher/relaunch72-publisher.php' ); include WP_PLUGIN_DIR . '/relaunch72-publisher/uninstall.php'; global $wpdb; return array( 'options' => $wpdb->get_col( "SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE 'r72pub%'" ), 'managedMeta' => (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->postmeta} WHERE meta_key='_r72_article_id'" ) );
		}
		return new WP_Error( 'bad_op', 'bad op' );
	} ) );
} );
add_action( 'rest_api_init', function () {
	register_rest_route( 'r72test/v1', '/probe', array( 'methods' => 'POST', 'permission_callback' => function ( $r ) { return hash_equals( R72_TEST_TOKEN, (string) $r->get_header( 'x_test_token' ) ); }, 'callback' => function ( $r ) {
		$a = $r->get_json_params();
		if ( 'flush' === ( $a['op'] ?? '' ) ) { delete_option( 'rewrite_rules' ); return array( 'ok' => true ); }
		$out = array();
		foreach ( array( 'rank_math_modules', 'rank-math-options-general', 'rank_math_registration_skip', 'rank_math_wizard_completed', 'wpseo' ) as $o ) { $v = get_option( $o, null ); $out[ $o ] = is_array( $v ) ? array_slice( $v, 0, 12, true ) : $v; }
		$out['core_sitemaps'] = wp_sitemaps_get_server()->sitemaps_enabled();
		$out['wp'] = get_bloginfo( 'version' ); $out['php'] = PHP_VERSION; $out['plugin_file'] = WP_PLUGIN_DIR . '/relaunch72-publisher/relaunch72-publisher.php'; $out['plugin_exists'] = file_exists( $out['plugin_file'] );
		$out['log'] = file_exists( WP_CONTENT_DIR . '/debug.log' ) ? substr( file_get_contents( WP_CONTENT_DIR . '/debug.log' ), -1500 ) : '';
		return $out;
	} ) );
} );
add_action( 'rest_api_init', function () {
	register_rest_route( 'r72test/v1', '/admin', array( 'methods' => 'POST', 'permission_callback' => function ( $r ) { return hash_equals( R72_TEST_TOKEN, (string) $r->get_header( 'x_test_token' ) ); }, 'callback' => function ( $r ) {
		$a = $r->get_json_params();
		wp_set_current_user( 1 );
		require_once ABSPATH . 'wp-admin/includes/admin.php';
		if ( ! empty( $a['proposal'] ) ) { set_transient( 'r72pub_site_proposal_1', $a['proposal'], 600 ); }
		if ( ! empty( $a['public_check'] ) ) { set_transient( 'r72pub_public_check', R72Pub_Admin::public_check(), 600 ); }
		$_GET['tab'] = $a['tab']; $_GET['r72notice'] = $a['notice'] ?? '';
		ob_start(); R72Pub_Admin::page(); $html = ob_get_clean();
		return array( 'html' => $html );
	} ) );
} );
